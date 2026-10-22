import { useEffect, useState } from "react";
import { formatTime } from "../format";
import { type ThumbTile, thumbAtTime } from "../hooks/useVttThumbnails";

const PREVIEW_WIDTH = 160;

// Natural sprite-sheet sizes, cached per sheet. The VTT does not declare the
// sheet size, but CSS sprites need it for background-size; measure once.
const sheetSizeCache = new Map<string, { width: number; height: number }>();

/** Seek-bar hover preview: the sprite tile covering `time`, drawn as a CSS sprite. */
export function ThumbnailPreview({ tiles, time }: { tiles: ThumbTile[] | null; time: number }) {
  const tile = tiles ? thumbAtTime(tiles, time) : null;
  const sheetUrl = tile?.sheetUrl ?? null;
  const [sheet, setSheet] = useState<{ url: string; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!sheetUrl) return;
    const cached = sheetSizeCache.get(sheetUrl);
    if (cached) {
      setSheet({ url: sheetUrl, ...cached });
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      sheetSizeCache.set(sheetUrl, size);
      if (!cancelled) setSheet({ url: sheetUrl, ...size });
    };
    img.src = sheetUrl;
    return () => {
      cancelled = true;
    };
  }, [sheetUrl]);

  const ready = tile && tile.width > 0 && sheet && sheet.url === sheetUrl && sheet.width > 0;
  const scale = ready ? PREVIEW_WIDTH / tile.width : 1;

  return (
    <>
      {ready && (
        <div
          className="evs-p-thumb"
          style={{
            width: PREVIEW_WIDTH,
            height: tile.height * scale,
            backgroundImage: `url("${sheetUrl}")`,
            backgroundPosition: `-${tile.x * scale}px -${tile.y * scale}px`,
            backgroundSize: `${sheet.width * scale}px ${sheet.height * scale}px`,
          }}
        />
      )}
      <span className="evs-p-chip">{formatTime(time)}</span>
    </>
  );
}
