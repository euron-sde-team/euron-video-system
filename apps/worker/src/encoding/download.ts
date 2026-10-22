import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { run } from "./exec.js";

/**
 * Config-driven video-encode args for the downloadable MP4 (capped-CRF H.264 by
 * default; HEVC opt-in).
 *
 * The download is a SEPARATE, size-conscious re-encode of the top rung, not a
 * copy of the ~5 Mbps streaming rung (which produces multi-GB downloads). H.264
 * capped CRF (CRF 23, never above ~2.8 Mbps) runs ~1x realtime on CPU-only
 * workers, plays on every device, and roughly halves the size. HEVC shrinks
 * more but is 2-4x slower and needs HEVC-capable players, so it is opt-in.
 */
export const downloadVideoArgs = (): string[] => {
  const cfg = getWorkerConfig();
  const codec = cfg.DOWNLOAD_VIDEO_CODEC;
  const args = ["-c:v", codec, "-crf", cfg.DOWNLOAD_CRF, "-preset", cfg.DOWNLOAD_PRESET];
  // Optional rate cap = "capped CRF": keep CRF quality but never exceed the cap,
  // so the size reduction is deterministic even on complex content (bufsize =
  // 2x cap). DOWNLOAD_MAXRATE_KBPS=0 gives pure CRF (e.g. for HEVC).
  if (cfg.DOWNLOAD_MAXRATE_KBPS > 0) {
    args.push("-maxrate", `${cfg.DOWNLOAD_MAXRATE_KBPS}k`, "-bufsize", `${cfg.DOWNLOAD_MAXRATE_KBPS * 2}k`);
  }
  // `-tag:v hvc1` makes HEVC play on Apple (QuickTime/Safari/iOS); Apple rejects
  // the default `hev1` tag. For H.264 use the broadly-compatible high profile.
  if (codec === "libx265") args.push("-tag:v", "hvc1");
  else args.push("-profile:v", "high");
  args.push("-pix_fmt", "yuv420p");
  return args;
};

/**
 * Produce the downloadable MP4 by re-encoding straight from the SOURCE, scaled
 * to the top rung's dimensions. The streaming rungs live in object storage (as
 * AES-128 TS), not on this worker, so the job re-downloads the source and encodes
 * from it rather than remuxing a local rung.
 *
 * A SIMPLE -vf filtergraph autorotates the input (unlike the complex-filtergraph
 * ladder in ffmpeg.ts), so passing the top rung's aspect-preserving scale filter
 * yields correctly-oriented output with no explicit transpose.
 *
 * The caller uploads the result to the PRIVATE downloads bucket: it is the full
 * unencrypted video and must never be publicly reachable.
 */
export const encodeDownloadFromSource = async (
  inputPath: string,
  workDir: string,
  scaleFilter: string,
  hasAudio: boolean,
  durationSec = 0,
  signal?: AbortSignal
): Promise<string> => {
  const outPath = path.join(workDir, "processed.mp4");
  const args = ["-y", "-i", inputPath, "-vf", scaleFilter, "-map", "0:v:0"];
  if (hasAudio) args.push("-map", "0:a:0");
  args.push(...downloadVideoArgs());
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  if (durationSec > 0) args.push("-t", String(durationSec));
  args.push("-movflags", "+faststart", outPath);

  await run(getWorkerConfig().FFMPEG_BIN, args, "download-from-source", { signal });
  return outPath;
};
