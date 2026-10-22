import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { run } from "./exec.js";
import type { Rung } from "./ladder.js";

export interface TranscodeResult {
  /** Per-rung mp4 file paths, keyed by rung name. */
  videoFiles: { rung: Rung; file: string }[];
  /** Extracted AAC audio file path, or null if the source had no audio. */
  audioFile: string | null;
}

/**
 * A source at/below this fps (or with an unusable rate) is "near-static": a
 * slide deck / screen-hold at ~0.14 fps, the case that breaks MSE with ~1 frame
 * per segment. The floor is deliberately BELOW every real capture/broadcast
 * rate (15 / 23.976 / 24 / 25 / 30 / 60) so NORMAL videos are never treated as
 * static. Such sources need TWO special cases, both keyed off this predicate:
 *   1. force CFR to MIN_OUTPUT_FPS (a per-output `-r`; see transcode below), and
 *   2. SKIP the source-bitrate cap (their video stream is ~2 kbps because there
 *      is no motion; capping the CFR keyframes to that starves x264 into flat
 *      gray, so the caller passes bitrateKbps=0 to selectLadder for these).
 *      x264 still undershoots on the static picture, so files stay small.
 */
export const NEAR_STATIC_FPS = 10;
export const isNearStatic = (sourceFps: number): boolean => sourceFps <= 0 || sourceFps < NEAR_STATIC_FPS;

/** Clockwise display rotation as a transpose chain, or null for 0. */
export const rotationFilter = (rotation: number): string | null =>
  rotation === 90
    ? "transpose=1" // 90deg clockwise
    : rotation === 270
      ? "transpose=2" // 90deg counter-clockwise
      : rotation === 180
        ? "transpose=1,transpose=1"
        : null;

/** `[0:v]{rot,}split=N[s0]..;[s0]scale..[v0];...` for N rungs. Pure, unit-tested. */
export const buildFilterComplex = (rungs: Rung[], rotation: number): string => {
  const rot = rotationFilter(rotation);
  const splitLabels = rungs.map((_, i) => `[s${i}]`).join("");
  const splitChain = `[0:v]${rot ? `${rot},` : ""}split=${rungs.length}${splitLabels}`;
  const scaleChains = rungs.map((r, i) => `[s${i}]${r.scaleFilter}[v${i}]`);
  return [splitChain, ...scaleChains].join(";");
};

/**
 * ONE FFmpeg process: decode once, split, encode every rung + extract audio.
 *
 * Why a single process: spawning one ffmpeg per rung decodes the source N
 * times, wasting the CPU. `split=N` fans the decoded frames into N scale chains
 * so the source is decoded exactly once.
 *
 * Why -force_key_frames expr: every rung gets IDR frames at the SAME timestamps
 * (every 4s, frame-rate independent). Without aligned keyframes ABR switching
 * tears and the segmenter can't cut clean, switchable segments. `-g` /
 * `-keyint_min` are frame-count based and drift across rungs; do not use them.
 *
 * Why the fps floor (sourceFps): a near-static / VFR source (slide deck +
 * voiceover) carries an effective rate well under 1 fps. Passed through, the HLS
 * output holds ~1 video frame per segment with avg_frame_rate=0/0, which
 * hls.js/MSE cannot play (fatal MEDIA_ERROR, "Playback failed").
 */
export const transcode = async (
  inputPath: string,
  workDir: string,
  rungs: Rung[],
  hasAudio: boolean,
  rotation = 0,
  durationSec = 0,
  sourceFps = 0,
  signal?: AbortSignal
): Promise<TranscodeResult> => {
  const cfg = getWorkerConfig();
  // Rotation is applied BEFORE the split so every rung inherits it from the
  // single decode. ffmpeg does NOT autorotate complex-filtergraph inputs (only
  // simple -vf / direct outputs), so we rotate explicitly; the matching
  // -noautorotate below forces [0:v] to coded frames on every ffmpeg build, so
  // this transpose is the sole rotation (never a double-rotate).
  const rotFilter = rotationFilter(rotation);

  // CFR normalisation ONLY for a near-static / unusable-fps source. CFR is
  // enforced with a per-output `-r`, NOT an `fps` filter before the split: a
  // pre-split `fps` feeding split's consumers at different drain rates on a VFR
  // source made ffmpeg emit uninitialised gray (128) frames and stall the encode.
  // `-r` duplicates frames per output stream after the split, so the split only
  // buffers the sparse source frames.
  const forceCfr = isNearStatic(sourceFps);

  const args: string[] = ["-y"];
  if (rotFilter) args.push("-noautorotate"); // input option: must precede -i
  args.push("-i", inputPath, "-filter_complex", buildFilterComplex(rungs, rotation));

  // Defensive: bound every output to the probed source duration so a filter
  // graph that fails to propagate EOF can't run away. For a normal source -t
  // equals the real duration, so it's a no-op. Skipped (=0) only if the probe
  // could not determine a duration.
  const durationArgs = durationSec > 0 ? ["-t", String(durationSec)] : [];

  const videoFiles: { rung: Rung; file: string }[] = [];
  rungs.forEach((rung, i) => {
    const file = path.join(workDir, `v_${rung.name}.mp4`);
    videoFiles.push({ rung, file });
    args.push(
      "-map", `[v${i}]`,
      // Per-output CFR for a near-static/VFR source (see above). Omitted for
      // normal sources so their rate + command stay unchanged.
      ...(forceCfr ? ["-r", String(cfg.MIN_OUTPUT_FPS)] : []),
      "-c:v", "libx264",
      // Capped-CRF rate control: CRF picks the quantiser the content needs (sharp
      // text on screencasts, transparent stills) while maxrate/bufsize bound
      // bursts (scrolls, cuts) so segments stay streamable. Single-pass ABR (-b:v)
      // spreads the budget evenly and blurs fine text at the same maxrate; CRF
      // also undershoots hard on static stretches, so screencast files SHRINK.
      // rung.videoKbps stays the nominal target: capToSource + the master
      // BANDWIDTH (maxrateKbps) are derived from it.
      "-crf", String(cfg.LADDER_CRF),
      "-maxrate", `${rung.maxrateKbps}k`,
      "-bufsize", `${rung.bufsizeKbps}k`,
      // Weaker in-loop deblocking preserves text/edge detail on screen content;
      // imperceptible on camera footage. (Comma separator: ':' splits params.)
      "-x264-params", "deblock=-1,-1",
      "-preset", cfg.LADDER_PRESET,
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-threads", "0",
      "-force_key_frames", "expr:gte(t,n_forced*4)",
      "-an",
      ...durationArgs,
      "-movflags", "+faststart",
      file
    );
  });

  let audioFile: string | null = null;
  if (hasAudio) {
    audioFile = path.join(workDir, "audio.mp4");
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-vn", ...durationArgs, audioFile);
  }

  await run(cfg.FFMPEG_BIN, args, "ffmpeg-transcode", { signal });
  return { videoFiles, audioFile };
};
