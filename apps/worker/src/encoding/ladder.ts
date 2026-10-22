import { getWorkerConfig } from "@evs/core/config";
import type { Orientation } from "./probe.js";

export interface Rung {
  /** Label used for the output dir + manifest (e.g. "1080", "720"). */
  name: string;
  width: number;
  height: number;
  /** ffmpeg scale filter applied to this rung's split output. Aspect-preserving via -2. */
  scaleFilter: string;
  videoKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
}

/** Source-bitrate cap knobs. Defaults come from worker config; tests pass them explicitly. */
export interface CapOptions {
  enabled: boolean;
  factor: number;
  floor: number;
}

const capOptionsFromConfig = (): CapOptions => {
  const cfg = getWorkerConfig();
  return { enabled: cfg.CAP_TO_SOURCE, factor: cfg.CAP_TO_SOURCE_FACTOR, floor: cfg.CAP_TO_SOURCE_FLOOR };
};

// 16:9 landscape. scale=-2:H (fix height, auto even width).
// Ladder trimmed to 1080/720/480 (240p + 360p dropped): the low rungs cost
// storage and egress for little benefit on modern connections. 480 is the floor.
// flags=lanczos: the default bicubic downscale visibly softens fine text when a
// Retina/1440p+ screen recording lands on the 1080p rung; lanczos keeps text
// edges crisp at zero playback cost (slightly slower scale, negligible vs encode).
export const LANDSCAPE: Rung[] = [
  { name: "1080", width: 1920, height: 1080, scaleFilter: "scale=-2:1080:flags=lanczos", videoKbps: 5000, maxrateKbps: 5350, bufsizeKbps: 7500 },
  { name: "720", width: 1280, height: 720, scaleFilter: "scale=-2:720:flags=lanczos", videoKbps: 3000, maxrateKbps: 3210, bufsizeKbps: 4500 },
  { name: "480", width: 854, height: 480, scaleFilter: "scale=-2:480:flags=lanczos", videoKbps: 1400, maxrateKbps: 1500, bufsizeKbps: 2100 },
];

// 9:16 vertical / short-form. scale=W:-2 (fix width, auto even height).
// Trimmed to 1080/720/540; 540 is the natural 9:16 mid/floor rung.
export const VERTICAL: Rung[] = [
  { name: "1080", width: 1080, height: 1920, scaleFilter: "scale=1080:-2:flags=lanczos", videoKbps: 5000, maxrateKbps: 5350, bufsizeKbps: 7500 },
  { name: "720", width: 720, height: 1280, scaleFilter: "scale=720:-2:flags=lanczos", videoKbps: 3000, maxrateKbps: 3210, bufsizeKbps: 4500 },
  { name: "540", width: 540, height: 960, scaleFilter: "scale=540:-2:flags=lanczos", videoKbps: 1600, maxrateKbps: 1700, bufsizeKbps: 2400 },
];

/**
 * Pick the ladder by orientation, then drop rungs that would UPSCALE the source
 * (wasted compute + egress, lower quality than source). Always keeps at least
 * the floor rung so even a tiny source produces one playable rendition.
 */
export const selectLadder = (
  orientation: Orientation,
  srcWidth: number,
  srcHeight: number,
  sourceBitrateKbps = 0,
  cap: CapOptions = capOptionsFromConfig()
): Rung[] => {
  const table = orientation === "portrait" ? VERTICAL : LANDSCAPE;
  const sourceLimit = orientation === "portrait" ? srcWidth : srcHeight;
  const limitOf = (r: Rung) => (orientation === "portrait" ? r.width : r.height);

  const fit = table.filter((r) => limitOf(r) <= sourceLimit);
  const rungs = fit.length > 0 ? fit : [table[table.length - 1] as Rung];
  return capToSource(rungs, sourceBitrateKbps, cap);
};

/**
 * A probed source bitrate below this is NOT a usable quality signal: it means a
 * static screen recording (screen-hold at a normal container fps, so the
 * fps-based near-static guard in encoding/ffmpeg.ts does not fire) whose encoder
 * emitted almost no bits. Capping to it starves x264 (a real video once shipped
 * a ~2 kbps 720p rung: flat gray). Treat it like bitrate-unknown and keep the
 * full ladder; x264 undershoots on the static picture anyway, so files stay small.
 */
export const MIN_TRUSTED_SOURCE_KBPS = 250;

/**
 * Cap each rung's bitrate to the source bitrate (x factor) so a low-bitrate
 * source is not encoded at the fixed ladder targets, but never below the
 * per-rung quality FLOOR (videoKbps x floor). The floor exists for screen
 * recordings (static whitish screens: slides, notebooks, code): they probe at a
 * few hundred kbps, and an unfloored cap encoded 1080p text at 300-900 kbps,
 * i.e. visible blur; re-encoding at ~source bitrate is a generation loss, not
 * transparency. Never RAISES a rung above its ladder target, so a rung already
 * below the cap is byte-for-byte unchanged. Deterministic in
 * (rungs, sourceBitrateKbps) for a fixed config, so the PRIMARY transcode and the
 * decoupled CAPTIONS master rebuild compute an identical ladder. No-op when
 * disabled or the probed bitrate is untrusted (< MIN_TRUSTED_SOURCE_KBPS, incl. 0).
 */
const capToSource = (rungs: Rung[], sourceBitrateKbps: number, opts: CapOptions): Rung[] => {
  if (!opts.enabled || sourceBitrateKbps < MIN_TRUSTED_SOURCE_KBPS) return rungs;
  const cap = Math.round(sourceBitrateKbps * opts.factor);
  return rungs.map((r) => {
    if (r.videoKbps <= cap) return r;
    const floor = Math.round(r.videoKbps * opts.floor);
    const capped = Math.min(Math.max(cap, floor), r.videoKbps);
    if (capped === r.videoKbps) return r;
    return {
      ...r,
      videoKbps: capped,
      maxrateKbps: Math.round(capped * 1.07),
      bufsizeKbps: Math.round(capped * 1.5),
    };
  });
};
