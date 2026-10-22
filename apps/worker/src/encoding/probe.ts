import { getWorkerConfig } from "@evs/core/config";
import { run } from "./exec.js";

export type Orientation = "landscape" | "portrait" | "square";

export interface ProbeResult {
  /** DISPLAY width (after rotation); drives orientation + the ABR ladder. */
  width: number;
  /** DISPLAY height (after rotation). */
  height: number;
  durationSec: number;
  orientation: Orientation;
  hasAudio: boolean;
  /**
   * Clockwise rotation (0/90/180/270) the transcode must apply for correct
   * display. ffmpeg does NOT autorotate complex-filtergraph inputs, so the
   * worker rotates explicitly using this value (see encoding/ffmpeg.ts).
   */
  rotation: number;
  /**
   * Source bitrate in kbps (video stream bitrate, else the container total which
   * includes audio, a safe over-estimate). 0 when ffprobe cannot report one. Used
   * by selectLadder to cap rung bitrates to the source (CAP_TO_SOURCE).
   */
  bitrateKbps: number;
  /**
   * Effective source frame rate in fps, from avg_frame_rate (falls back to
   * r_frame_rate). 0 when ffprobe reports neither (e.g. avg_frame_rate="0/0" on a
   * near-static source). The transcoder forces CFR at MIN_OUTPUT_FPS when this is
   * 0 or below the floor, so a slideshow source cannot ship ~1 frame/segment (which
   * breaks hls.js/MSE playback). See encoding/ffmpeg.ts.
   */
  fps: number;
}

export interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number;
}
export interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: FfprobeSideData[];
}
export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string };
}

const classify = (w: number, h: number): Orientation => {
  if (w === h) return "square";
  return w > h ? "landscape" : "portrait";
};

/**
 * Parse an ffprobe frame-rate rational ("num/den", e.g. "30000/1001") into fps.
 * Returns 0 for the degenerate cases ffprobe emits on VFR / near-static sources
 * ("0/0", a zero denominator, or a non-numeric value) so callers can treat "no
 * usable frame rate" and "genuinely low frame rate" uniformly.
 */
export const parseFrameRate = (value?: string): number => {
  if (!value) return 0;
  const [numStr, denStr] = value.split("/");
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) {
    return 0;
  }
  return num / den;
};

/**
 * Clockwise display rotation in {0,90,180,270}, replicating ffmpeg's own
 * autorotate so the explicitly-rotated renditions match the natively-rotated
 * thumbnails (simple -vf filtergraphs DO autorotate). ffmpeg derives
 * theta = -round(displayMatrixRotation); ffprobe reports that rotation in
 * side_data_list[].rotation. The legacy `tags.rotate` is already the clockwise
 * display angle (rotate=90 == matrix rotation -90), so it maps directly.
 * Prefer the modern Display Matrix; fall back to the legacy tag.
 */
export const displayRotation = (stream: FfprobeStream): number => {
  const norm = (deg: number): number => ((Math.round(deg) % 360) + 360) % 360;
  const snap = (theta: number): number => (theta === 90 || theta === 180 || theta === 270 ? theta : 0);

  const dm = (stream.side_data_list ?? []).find((s) => s.side_data_type === "Display Matrix");
  if (dm && typeof dm.rotation === "number") {
    return snap(norm(-dm.rotation));
  }
  const tag = stream.tags?.rotate;
  if (tag !== undefined && tag !== "") {
    return snap(norm(Number(tag)));
  }
  return 0;
};

/** Pure interpretation of ffprobe JSON. Separated from the spawn so it is unit-testable. */
export const interpretProbe = (parsed: FfprobeOutput): ProbeResult => {
  const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  if (!video?.width || !video?.height) {
    throw new Error("ffprobe: no video stream / dimensions found");
  }

  const rotation = displayRotation(video);
  // A 90/270 rotation swaps the displayed dimensions vs the coded ones; 0/180
  // leave them as-is. Downstream (classify + ladder + scale filters) all work
  // off these display dimensions, matching the rotated frames the transcoder
  // produces.
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? video.height : video.width;
  const height = swap ? video.width : video.height;

  const durationSec = Math.max(0, Math.round(Number(parsed.format?.duration ?? 0)));
  const hasAudio = (parsed.streams ?? []).some((s) => s.codec_type === "audio");

  // Prefer the video stream's own bitrate; fall back to the container total (which
  // includes audio, a safe over-estimate for capping). 0 when neither is reported.
  const videoBps = Number(video.bit_rate ?? 0);
  const formatBps = Number(parsed.format?.bit_rate ?? 0);
  const bitrateBps = videoBps > 0 ? videoBps : formatBps;
  const bitrateKbps = bitrateBps > 0 ? Math.round(bitrateBps / 1000) : 0;

  // avg_frame_rate is the true average (0/0 on VFR/near-static); r_frame_rate is
  // the base rate ffmpeg falls back on. Prefer the average, then the base.
  const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate);

  return {
    width,
    height,
    durationSec,
    orientation: classify(width, height),
    hasAudio,
    rotation,
    bitrateKbps,
    fps,
  };
};

/**
 * ffprobe the source for dimensions + duration + rotation. Orientation picks
 * the ladder (landscape vs vertical) and the player layout; rotation tells the
 * transcoder how to orient the output. Square is treated as landscape
 * downstream but recorded distinctly.
 */
export const probe = async (inputPath: string, signal?: AbortSignal): Promise<ProbeResult> => {
  const { stdout } = await run(
    getWorkerConfig().FFPROBE_BIN,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", inputPath],
    "ffprobe",
    { signal }
  );
  return interpretProbe(JSON.parse(stdout) as FfprobeOutput);
};
