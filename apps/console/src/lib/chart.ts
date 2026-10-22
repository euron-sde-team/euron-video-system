/**
 * Geometry for the small daily bar charts on the Usage page. Pure, so it is
 * unit-tested without a DOM. Values map onto a "nice" axis maximum so gridline
 * labels read as round numbers.
 */

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  label: string;
}

/** Smallest of 1, 2, 2.5, 5 x 10^n that is >= value. 0 stays 0 -> axis of 1. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= value) return m * base;
  return 10 * base;
}

export function layoutBars(points: Array<{ label: string; value: number }>, width: number, height: number, gap = 2): { bars: Bar[]; max: number } {
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const n = points.length;
  if (n === 0 || width <= 0 || height <= 0) return { bars: [], max };
  const slot = width / n;
  const barWidth = Math.max(1, slot - gap);
  const bars = points.map((p, i) => {
    const h = Math.max(0, (p.value / max) * height);
    return { x: i * slot + (slot - barWidth) / 2, y: height - h, width: barWidth, height: h, value: p.value, label: p.label };
  });
  return { bars, max };
}

/** Inclusive list of ISO dates (YYYY-MM-DD) from `from` to `to`, for zero-filling gaps. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
