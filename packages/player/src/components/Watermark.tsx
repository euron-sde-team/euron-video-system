import { useEffect, useRef, useState } from "react";

/**
 * Repositioning identity overlay. Pure DOM, no media changes: it jumps to a new
 * pseudo-random spot every few seconds so a static crop cannot remove it from
 * the whole timeline. A visible deterrent and an attribution aid for leaked
 * screen recordings; it is not a security boundary.
 */
export function Watermark({ text, intervalMs = 4000, opacity = 0.32, color = "#ffffff" }: { text: string; intervalMs?: number; opacity?: number; color?: string }) {
  const seedRef = useRef<number>((text.length * 2654435761) % 2147483647 || 1);
  const [pos, setPos] = useState({ top: 8, left: 8 });

  useEffect(() => {
    // xorshift32: deterministic per text, cheap, good enough to avoid patterns.
    const next = () => {
      let s = seedRef.current;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      seedRef.current = s;
      return Math.abs(s % 1000) / 1000;
    };
    const move = () => setPos({ top: 5 + next() * 75, left: 5 + next() * 70 });
    move();
    const timer = window.setInterval(move, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return (
    <div className="evs-p-wm" aria-hidden="true" style={{ top: `${pos.top}%`, left: `${pos.left}%`, opacity, color }}>
      {text}
    </div>
  );
}
