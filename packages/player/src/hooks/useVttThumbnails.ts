import { useEffect, useState } from "react";

/** One scrub-preview tile: a region of a sprite sheet covering a time range. */
export interface ThumbTile {
  startTime: number;
  duration: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absolute sprite-sheet URL (fragment stripped). */
  sheetUrl: string;
}

/** "HH:MM:SS.mmm" or "MM:SS.mmm" to seconds; null if malformed. */
function parseVttTime(s: string): number | null {
  const parts = s.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [a = 0, b = 0, c = 0] = parts;
  return parts.length === 3 ? a * 3600 + b * 60 + c : a * 60 + b;
}

/**
 * Parse a sprite-sheet WebVTT: each cue is `start --> end` followed by
 * `sprite_NNN.jpg#xywh=x,y,w,h`. Sheet URLs are resolved against `baseUrl`, so
 * both relative paths and the absolute, signed URLs the API writes in work.
 */
export function parseThumbnailVtt(vtt: string, baseUrl: string): ThumbTile[] {
  const tiles: ThumbTile[] = [];
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const arrow = line.indexOf("-->");
    if (arrow === -1) continue;
    const start = parseVttTime(line.slice(0, arrow).trim());
    const end = parseVttTime(line.slice(arrow + 3).trim().split(/\s+/)[0] ?? "");
    if (start == null || end == null) continue;

    let payload = "";
    for (let j = i + 1; j < lines.length; j++) {
      const p = (lines[j] ?? "").trim();
      if (p) {
        payload = p;
        break;
      }
    }
    const hash = payload.indexOf("#xywh=");
    if (hash === -1) continue;
    const [x, y, w, h] = payload
      .slice(hash + 6)
      .split(",")
      .map(Number);
    if (x === undefined || y === undefined || w === undefined || h === undefined) continue;
    if ([x, y, w, h].some((n) => Number.isNaN(n))) continue;

    tiles.push({
      startTime: start,
      duration: Math.max(0, end - start),
      x,
      y,
      width: w,
      height: h,
      sheetUrl: new URL(payload.slice(0, hash), baseUrl).href,
    });
  }
  return tiles;
}

/** The tile covering `time`; clamps to the last tile past the final cue. */
export function thumbAtTime(tiles: ThumbTile[], time: number): ThumbTile | null {
  for (const t of tiles) if (time >= t.startTime && time < t.startTime + t.duration) return t;
  return tiles[tiles.length - 1] ?? null;
}

/** Fetch + parse a thumbnails VTT once. Best-effort: previews simply do not show on failure. */
export function useVttThumbnails(url: string | null): ThumbTile[] | null {
  const [tiles, setTiles] = useState<ThumbTile[] | null>(null);

  useEffect(() => {
    if (!url) {
      setTiles(null);
      return;
    }
    const abs = new URL(url, window.location.href).href;
    const ctrl = new AbortController();
    fetch(abs, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`thumbnails ${r.status}`))))
      .then((text) => setTiles(parseThumbnailVtt(text, abs)))
      .catch(() => {
        if (!ctrl.signal.aborted) setTiles(null);
      });
    return () => ctrl.abort();
  }, [url]);

  return tiles;
}
