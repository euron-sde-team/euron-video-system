import { EvsPlayer, type PlayerSource } from "@evs/player";
import { ArrowLeft, Download, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { createPlaybackSession, getDownloadUrl, usePolicies, useRevokeSession, useSessions, useUpdateVideo, useVideo, useVideoAction } from "../api/hooks";
import { ArtifactStatus, VideoStatusCell } from "../components/status";
import { useToast } from "../components/toast";
import { Button, DefinitionList, Empty, ErrorNote, Mono, PageHeader, Panel, StatusDot } from "../components/ui";
import { triggerBrowserDownload } from "../lib/download";
import { errorMessage } from "../lib/api";
import { formatBytes, formatDateTime, formatDuration, formatRelative } from "../lib/format";
import type { PlaybackSessionGrant, Video } from "../lib/types";

const PREVIEW_VIEWER = "console-preview";

export function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const video = useVideo(id);

  if (video.isError) {
    return (
      <>
        <BackLink />
        <ErrorNote error={errorMessage(video.error)} onRetry={() => void video.refetch()} />
      </>
    );
  }
  if (!video.data) return <BackLink />;
  return <Detail video={video.data} />;
}

function BackLink() {
  return (
    <Link to="/videos" className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
      <ArrowLeft className="h-3.5 w-3.5" /> Videos
    </Link>
  );
}

function Detail({ video }: { video: Video }) {
  const toast = useToast();
  const action = useVideoAction();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const d = await getDownloadUrl(video.id);
      triggerBrowserDownload(d.url, d.filename);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <BackLink />
      <PageHeader
        title={video.title}
        description={<Mono>{video.id}</Mono>}
        actions={
          <>
            {video.status === "failed" && (
              <Button icon={<RotateCcw className="h-3.5 w-3.5" />} loading={action.isPending} onClick={() => action.mutate({ id: video.id, action: "retry" })}>
                Retry
              </Button>
            )}
            <Button icon={<Download className="h-3.5 w-3.5" />} disabled={video.download.status !== "ready"} loading={downloading} onClick={() => void download()}>
              Download MP4
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          {video.status === "ready" ? (
            <PreviewPlayer video={video} />
          ) : (
            <div className="flex aspect-video flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface">
              <VideoStatusCell video={video} />
              {video.status === "failed" && video.error && <p className="max-w-md text-center text-xs text-bad">{video.error}</p>}
              {!["failed", "cancelled"].includes(video.status) && <p className="text-xs text-faint">The player appears as soon as the encrypted stream is published.</p>}
            </div>
          )}

          <Panel title="Renditions" flush>
            {video.renditions && video.renditions.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Rung</th>
                    <th className="th">Resolution</th>
                    <th className="th text-right">Bitrate</th>
                    <th className="th">Codec</th>
                  </tr>
                </thead>
                <tbody>
                  {video.renditions.map((r) => (
                    <tr key={r.label}>
                      <td className="td font-medium">{r.label}p</td>
                      <td className="td tabular-nums text-muted">
                        {r.width} x {r.height}
                      </td>
                      <td className="td text-right tabular-nums">{(r.bitrateKbps / 1000).toFixed(2)} Mbps</td>
                      <td className="td">
                        <Mono>{r.codec}</Mono>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="No renditions yet" description="The ABR ladder is chosen from the source's resolution and bitrate; no rung is ever upscaled." />
            )}
          </Panel>

          <SessionsPanel videoId={video.id} />
        </div>

        <div className="space-y-6">
          <Panel title="Details">
            <DefinitionList
              items={[
                ["Status", <VideoStatusCell key="s" video={video} />],
                ["Duration", formatDuration(video.durationSeconds)],
                ["Orientation", video.orientation ?? "-"],
                ["Protection", video.protection === "aes_128" ? "AES-128 HLS, KMS-wrapped key" : video.protection],
                ["Watermark", video.watermark.replace(/_/g, " ")],
                ["Source", formatBytes(video.sourceBytes)],
                ["Output", formatBytes(video.outputBytes)],
                ["Attempts", String(video.attempts)],
                ["External ref", video.externalRef ? <Mono key="e">{video.externalRef}</Mono> : "-"],
                ["Created", formatDateTime(video.createdAt)],
                ["Ready", formatDateTime(video.readyAt)],
              ]}
            />
          </Panel>
          <Panel title="Artifacts">
            <DefinitionList
              items={[
                ["Captions", <ArtifactStatus key="c" status={video.captions.status} />],
                ["Languages", video.captions.languages.length ? video.captions.languages.join(", ") : "-"],
                ["Download MP4", <ArtifactStatus key="d" status={video.download.status} />],
              ]}
            />
          </Panel>
          <PolicyPanel video={video} />
          {Object.keys(video.metadata ?? {}).length > 0 && (
            <Panel title="Metadata">
              <pre className="overflow-x-auto font-mono text-xs text-muted">{JSON.stringify(video.metadata, null, 2)}</pre>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function PreviewPlayer({ video }: { video: Video }) {
  const [grant, setGrant] = useState<PlaybackSessionGrant | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async (): Promise<PlaybackSessionGrant> => createPlaybackSession(video.id, PREVIEW_VIEWER), [video.id]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    mint().then(
      (g) => !cancelled && setGrant(g),
      (err) => !cancelled && setError(errorMessage(err))
    );
    return () => {
      cancelled = true;
    };
  }, [mint]);

  const refresh = useCallback(async (): Promise<PlayerSource> => {
    const g = await mint();
    setGrant(g);
    return { manifestUrl: g.manifestUrl, thumbnailsUrl: g.thumbnailsUrl ?? undefined };
  }, [mint]);

  if (error) return <ErrorNote error={`Could not start a preview session: ${error}`} />;
  if (!grant) return <div className="aspect-video animate-pulse rounded-lg bg-surface" />;
  return (
    <div>
      <EvsPlayer
        manifestUrl={grant.manifestUrl}
        thumbnailsUrl={grant.thumbnailsUrl ?? undefined}
        posterUrl={grant.posterUrl ?? video.posterUrl ?? undefined}
        watermarkText={grant.watermark.required ? (grant.watermark.text ?? PREVIEW_VIEWER) : undefined}
        aspectRatio={video.orientation === "portrait" ? "9 / 16" : video.orientation === "square" ? "1 / 1" : "16 / 9"}
        onRefreshSession={refresh}
        style={video.orientation === "portrait" ? { maxHeight: "72vh", width: "auto", margin: "0 auto" } : undefined}
      />
      <p className="mt-2 text-xs text-faint">
        Preview session <Mono>{grant.sessionId}</Mono> for viewer <Mono>{PREVIEW_VIEWER}</Mono>, expires {formatRelative(grant.expiresAt)}.
      </p>
    </div>
  );
}

function PolicyPanel({ video }: { video: Video }) {
  const policies = usePolicies();
  const update = useUpdateVideo();
  const toast = useToast();
  const current = policies.data?.data.find((p) => p.id === video.playbackPolicyId) ?? policies.data?.data.find((p) => p.isDefault);
  return (
    <Panel title="Playback policy">
      <select
        className="input"
        value={video.playbackPolicyId ?? ""}
        onChange={(e) =>
          update.mutateAsync({ id: video.id, playbackPolicyId: e.target.value || null }).then(
            () => toast.ok("Playback policy updated"),
            (err) => toast.error(errorMessage(err))
          )
        }
      >
        <option value="">Default policy</option>
        {policies.data?.data.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
      {current && (
        <p className="mt-2 text-xs text-muted">
          Tokens live {current.tokenTtlSeconds}s, {current.maxConcurrentSessions ? `${current.maxConcurrentSessions} concurrent per viewer` : "unlimited concurrency"},{" "}
          {current.allowedOrigins.length ? `${current.allowedOrigins.length} allowed origin(s)` : "any origin"}.
        </p>
      )}
    </Panel>
  );
}

function SessionsPanel({ videoId }: { videoId: string }) {
  const sessions = useSessions({ videoId, limit: 20 });
  const revoke = useRevokeSession();
  const toast = useToast();
  return (
    <Panel title="Playback sessions" flush>
      {sessions.data && sessions.data.data.length > 0 ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Viewer</th>
              <th className="th">State</th>
              <th className="th">Origin</th>
              <th className="th text-right">Issued</th>
              <th className="th w-20" />
            </tr>
          </thead>
          <tbody>
            {sessions.data.data.map((s) => {
              const active = !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now();
              return (
                <tr key={s.id}>
                  <td className="td">
                    <Mono className="text-fg">{s.viewerId}</Mono>
                  </td>
                  <td className="td">
                    <StatusDot tone={active ? "ok" : s.revokedAt ? "bad" : "neutral"} label={active ? "Active" : s.revokedAt ? "Revoked" : "Expired"} />
                  </td>
                  <td className="td max-w-[180px] truncate text-muted">{s.origin ?? "-"}</td>
                  <td className="td text-right text-muted">{formatRelative(s.issuedAt)}</td>
                  <td className="td text-right">
                    {active && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          revoke.mutateAsync(s.id).then(
                            () => toast.ok("Session revoked. Its key requests now fail."),
                            (err) => toast.error(errorMessage(err))
                          )
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty title="No sessions" description="Each playback token minted for this video is tracked here and can be revoked." />
      )}
    </Panel>
  );
}
