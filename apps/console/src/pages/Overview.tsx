import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStats, useVideos } from "../api/hooks";
import { Poster } from "../components/Poster";
import { STATUS_LABEL, STATUS_TONE, VideoStatusCell } from "../components/status";
import { Button, Empty, ErrorNote, PageHeader, Panel, SkeletonRows, StatusDot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatBytes, formatDuration, formatNumber, formatRelative } from "../lib/format";
import { VIDEO_STATUSES } from "../lib/types";

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="px-5 py-4">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-faint">{sub}</div>}
    </div>
  );
}

export function OverviewPage() {
  const stats = useStats();
  const recent = useVideos({ page: 1, limit: 8 });
  const s = stats.data;
  const total = s?.videos.total ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Pipeline health at a glance. Refreshes every few seconds."
        actions={
          <Link to="/upload">
            <Button variant="primary">Upload video</Button>
          </Link>
        }
      />
      {stats.isError && (
        <div className="mb-4">
          <ErrorNote error={errorMessage(stats.error)} onRetry={() => void stats.refetch()} />
        </div>
      )}

      <div className="grid grid-cols-2 divide-x divide-y divide-line rounded-lg border border-line bg-surface md:grid-cols-4 md:divide-y-0">
        <Metric label="Videos" value={s ? formatNumber(total) : "-"} sub={s ? `${formatNumber(s.videos.byStatus.ready ?? 0)} ready to play` : undefined} />
        <Metric
          label="Queue"
          value={s ? formatNumber(s.queue.queued + s.queue.processing) : "-"}
          sub={s ? `${s.queue.queued} waiting, ${s.queue.processing} transcoding, ${s.queue.jobsQueued + s.queue.jobsProcessing} jobs` : undefined}
        />
        <Metric label="Storage" value={s ? formatBytes(s.storage.outputBytes) : "-"} sub={s ? `${formatBytes(s.storage.sourceBytes)} of source uploads` : undefined} />
        <Metric label="Active sessions" value={s ? formatNumber(s.activeSessions) : "-"} sub="Unexpired, unrevoked playback tokens" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_300px]">
        <Panel
          title="Recent videos"
          flush
          actions={
            <Link to="/videos" className="flex items-center gap-1 text-xs text-muted hover:text-fg">
              All videos <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          <table className="w-full">
            <tbody>
              {recent.isLoading && <SkeletonRows rows={5} cols={4} />}
              {recent.data?.data.map((v) => (
                <tr key={v.id} className="hover:bg-raised/50">
                  <td className="td max-w-0 w-1/2">
                    <div className="flex items-center gap-3">
                      <Poster video={v} />
                      <Link to={`/videos/${v.id}`} className="block min-w-0 truncate font-medium hover:underline">
                        {v.title}
                      </Link>
                    </div>
                  </td>
                  <td className="td">
                    <VideoStatusCell video={v} />
                  </td>
                  <td className="td text-right tabular-nums text-muted">{formatDuration(v.durationSeconds)}</td>
                  <td className="td text-right text-muted">{formatRelative(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recent.data && recent.data.data.length === 0 && (
            <Empty
              title="No videos yet"
              description="Upload a file and it will be transcoded into an encrypted adaptive stream."
              action={
                <Link to="/upload">
                  <Button variant="primary">Upload your first video</Button>
                </Link>
              }
            />
          )}
        </Panel>

        <Panel title="By status">
          <ul className="space-y-3">
            {VIDEO_STATUSES.map((st) => {
              const n = s?.videos.byStatus[st] ?? 0;
              const pct = total ? (n / total) * 100 : 0;
              return (
                <li key={st}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <StatusDot tone={STATUS_TONE[st]} label={STATUS_LABEL[st]} />
                    <span className="tabular-nums text-muted">{formatNumber(n)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-line">
                    <div className="h-full bg-fg/40" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </>
  );
}
