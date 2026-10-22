import { useRef, useState } from "react";
import type { BufferedRange } from "../hooks/usePlaybackState";
import type { ThumbTile } from "../hooks/useVttThumbnails";
import { ThumbnailPreview } from "./ThumbnailPreview";

interface Props {
  currentTime: number;
  duration: number;
  buffered: BufferedRange[];
  tiles: ThumbTile[] | null;
  onSeek: (time: number) => void;
  onScrubChange: (scrubbing: boolean) => void;
}

const PREVIEW_HALF_WIDTH = 88;

export function SeekBar({ currentTime, duration, buffered, tiles, onSeek, onScrubChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const total = duration > 0 ? duration : 0;

  const at = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, time: 0 };
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { x: ratio * rect.width, time: ratio * total };
  };

  const pct = (t: number) => (total ? (t / total) * 100 : 0);
  const shown = dragging && hover ? hover.time : currentTime;
  const width = barRef.current?.getBoundingClientRect().width ?? 0;
  const previewLeft = hover ? Math.max(PREVIEW_HALF_WIDTH, Math.min(width - PREVIEW_HALF_WIDTH, hover.x)) : 0;

  return (
    <div className="evs-p-seek">
      {hover && total > 0 && (
        <div className="evs-p-preview" style={{ left: previewLeft }}>
          <ThumbnailPreview tiles={tiles} time={hover.time} />
        </div>
      )}
      <div
        ref={barRef}
        className="evs-p-hit"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(shown)}
        tabIndex={0}
        onPointerDown={(e) => {
          if (!total) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          onScrubChange(true);
          const next = at(e.clientX);
          setHover(next);
          onSeek(next.time);
        }}
        onPointerMove={(e) => {
          if (!total) return;
          const next = at(e.clientX);
          setHover(next);
          if (dragging) onSeek(next.time);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          onScrubChange(false);
        }}
        onPointerLeave={() => !dragging && setHover(null)}
      >
        <div className="evs-p-track">
          {buffered.map((r, i) => (
            <div key={i} className="evs-p-buf" style={{ left: `${pct(r.start)}%`, width: `${pct(r.end - r.start)}%` }} />
          ))}
          <div className="evs-p-played" style={{ width: `${pct(shown)}%` }} />
          <div className={`evs-p-knob${dragging ? " evs-p-drag" : ""}`} style={{ left: `${pct(shown)}%` }} />
        </div>
      </div>
    </div>
  );
}
