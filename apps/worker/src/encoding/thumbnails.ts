import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { run } from "./exec.js";

export interface ThumbnailsResult {
  posterFile: string;
  spriteDir: string;
  vttFile: string;
  spriteCount: number;
}

export const THUMB_W = 160;
export const INTERVAL_SEC = 5;
export const COLS = 10;
export const ROWS = 10;
const PER_SPRITE = COLS * ROWS;

const even = (n: number) => (n % 2 === 0 ? n : n + 1);
const pad3 = (n: number) => String(n).padStart(3, "0");

export const vttTime = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
};

/** Thumbnail tile height for a source aspect ratio (even, >= 2). */
export const thumbHeight = (srcWidth: number, srcHeight: number): number =>
  even(Math.max(2, Math.round((THUMB_W * srcHeight) / srcWidth)));

/**
 * The #xywh WebVTT that maps each 5s interval to a tile inside its sprite sheet.
 * Sprite paths are relative to the VTT (the API rewrites them to signed URLs at
 * delivery time). Pure, so it is unit-tested without ffmpeg.
 */
export const buildThumbnailsVtt = (durationSec: number, srcWidth: number, srcHeight: number): string => {
  const thumbH = thumbHeight(srcWidth, srcHeight);
  const thumbCount = Math.max(1, Math.ceil(durationSec / INTERVAL_SEC));
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < thumbCount; i++) {
    const start = i * INTERVAL_SEC;
    const end = Math.min((i + 1) * INTERVAL_SEC, durationSec || (i + 1) * INTERVAL_SEC);
    const spriteIndex = Math.floor(i / PER_SPRITE) + 1; // ffmpeg %03d starts at 001
    const within = i % PER_SPRITE;
    const x = (within % COLS) * THUMB_W;
    const y = Math.floor(within / COLS) * thumbH;
    vtt += `${vttTime(start)} --> ${vttTime(end)}\n`;
    vtt += `sprite_${pad3(spriteIndex)}.jpg#xywh=${x},${y},${THUMB_W},${thumbH}\n\n`;
  }
  return vtt;
};

/**
 * Two cheap passes: a poster frame and a scrub-preview sprite sheet, plus a
 * #xywh WebVTT mapping each 5s interval to a tile region. A separate decode but
 * a fast one (1 frame / 5s, downscaled).
 */
export const generateThumbnails = async (
  inputPath: string,
  workDir: string,
  srcWidth: number,
  srcHeight: number,
  durationSec: number,
  signal?: AbortSignal
): Promise<ThumbnailsResult> => {
  const ffmpeg = getWorkerConfig().FFMPEG_BIN;
  const spriteDir = path.join(workDir, "thumbnails");
  await mkdir(spriteDir, { recursive: true });

  const posterFile = path.join(workDir, "poster.jpg");
  const posterAt = durationSec > 2 ? 1 : 0;

  // Poster (representative frame).
  await run(
    ffmpeg,
    ["-y", "-ss", String(posterAt), "-i", inputPath, "-frames:v", "1", "-q:v", "2", posterFile],
    "ffmpeg-poster",
    { signal }
  );

  // Sprite sheets: 1 frame every 5s, downscaled, tiled 10x10.
  await run(
    ffmpeg,
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `fps=1/${INTERVAL_SEC},scale=${THUMB_W}:-1,tile=${COLS}x${ROWS}`,
      "-q:v",
      "3",
      path.join(spriteDir, "sprite_%03d.jpg"),
    ],
    "ffmpeg-sprite",
    { signal }
  );

  const vttFile = path.join(spriteDir, "thumbnails.vtt");
  await writeFile(vttFile, buildThumbnailsVtt(durationSec, srcWidth, srcHeight), "utf8");

  const thumbCount = Math.max(1, Math.ceil(durationSec / INTERVAL_SEC));
  return { posterFile, spriteDir, vttFile, spriteCount: Math.ceil(thumbCount / PER_SPRITE) };
};
