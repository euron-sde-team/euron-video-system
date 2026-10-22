import { useMemo, useState } from "react";
import { useUsage } from "../api/hooks";
import { ErrorNote, PageHeader, Panel } from "../components/ui";
import { errorMessage } from "../lib/api";
import { dayRange, layoutBars } from "../lib/chart";
import { cn } from "../lib/cn";
import { formatMinutes, formatNumber } from "../lib/format";
import type { UsageDay } from "../lib/types";

const RANGES = [7, 30, 90] as const;
const W = 640;
const H = 140;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function UsagePage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const { from, to } = useMemo(() => {
    const end = new Date();
    return { from: isoDay(new Date(end.getTime() - (days - 1) * 86_400_000)), to: isoDay(end) };
  }, [days]);
  const usage = useUsage(from, to);

  // Zero-fill missing days so bars line up with the calendar.
  const series = useMemo(() => {
    const byDay = new Map((usage.data?.days ?? []).map((d) => [d.day.slice(0, 10), d]));
    return dayRange(from, to).map((day): UsageDay => byDay.get(day) ?? { day, videosCreated: 0, transcodeSeconds: 0, playbackSessions: 0, keyDeliveries: 0 });
  }, [usage.data, from, to]);

  const t = usage.data?.totals;

  return (
    <>
      <PageHeader
        title="Usage"
        description="Daily rollups written in the same transaction as the work they count."
        actions={
          <div className="flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5">
            {RANGES.map((r) => (
              <button key={r} onClick={() => setDays(r)} className={cn("h-7 rounded px-2.5 text-xs", days === r ? "bg-raised font-medium" : "text-muted hover:text-fg")}>
                {r}d
              </button>
            ))}
          </div>
        }
      />
      {usage.isError && <ErrorNote error={errorMessage(usage.error)} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <Chart title="Transcoded" total={t ? formatMinutes(t.transcodeSeconds) : "-"} series={series} pick={(d) => d.transcodeSeconds / 60} fmt={(v) => `${Math.round(v)} min`} />
        <Chart title="Playback sessions" total={t ? formatNumber(t.playbackSessions) : "-"} series={series} pick={(d) => d.playbackSessions} fmt={formatNumber} />
        <Chart title="Key deliveries" total={t ? formatNumber(t.keyDeliveries) : "-"} series={series} pick={(d) => d.keyDeliveries} fmt={formatNumber} />
        <Chart title="Videos created" total={t ? formatNumber(t.videosCreated) : "-"} series={series} pick={(d) => d.videosCreated} fmt={formatNumber} />
      </div>
    </>
  );
}

function Chart({ title, total, series, pick, fmt }: { title: string; total: string; series: UsageDay[]; pick: (d: UsageDay) => number; fmt: (v: number) => string }) {
  const { bars, max } = layoutBars(
    series.map((d) => ({ label: d.day, value: pick(d) })),
    W,
    H,
    series.length > 45 ? 1 : 3
  );
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null ? bars[hover] : undefined;

  return (
    <Panel title={title} actions={<span className="text-[15px] font-semibold tabular-nums">{total}</span>}>
      <div className="mb-1 flex h-4 justify-between text-2xs text-faint">
        <span>{hovered ? `${hovered.label}: ${fmt(hovered.value)}` : `max ${fmt(max)}`}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {bars.map((b, i) => (
          <g key={b.label} onMouseEnter={() => setHover(i)}>
            <rect x={b.x} y={0} width={b.width} height={H} fill="transparent" />
            <rect x={b.x} y={b.value > 0 ? Math.min(b.y, H - 1) : H - 1} width={b.width} height={b.value > 0 ? Math.max(1, b.height) : 1} rx={1} className={cn(hover === i ? "fill-accent" : b.value > 0 ? "fill-accent/60" : "fill-line")} />
          </g>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-2xs text-faint">
        <span>{series[0]?.day}</span>
        <span>{series[series.length - 1]?.day}</span>
      </div>
    </Panel>
  );
}
