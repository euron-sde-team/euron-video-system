import { useState } from "react";
import { Link } from "react-router-dom";
import { useRevokeSession, useSessions } from "../api/hooks";
import { useToast } from "../components/toast";
import { Button, Checkbox, Empty, ErrorNote, Mono, PageHeader, Panel, SkeletonRows, StatusDot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatRelative, shortId } from "../lib/format";

const LIMIT = 50;

export function SessionsPage() {
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState(1);
  const sessions = useSessions({ active: activeOnly || undefined, page, limit: LIMIT });
  const revoke = useRevokeSession();
  const toast = useToast();
  const total = sessions.data?.pagination.total ?? 0;

  return (
    <>
      <PageHeader
        title="Playback sessions"
        description="One row per minted playback token. Revoking a session makes its playlist and key requests fail on the next fetch."
        actions={<Checkbox checked={activeOnly} onChange={(v) => { setActiveOnly(v); setPage(1); }} label="Active only" />}
      />
      {sessions.isError && <ErrorNote error={errorMessage(sessions.error)} />}
      <Panel flush>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Session</th>
              <th className="th">Viewer</th>
              <th className="th">Video</th>
              <th className="th">State</th>
              <th className="th">Origin</th>
              <th className="th">User agent</th>
              <th className="th text-right">Issued</th>
              <th className="th text-right">Expires</th>
              <th className="th w-20" />
            </tr>
          </thead>
          <tbody>
            {sessions.isLoading && <SkeletonRows rows={6} cols={9} />}
            {sessions.data?.data.map((s) => {
              const active = !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now();
              return (
                <tr key={s.id} className="hover:bg-raised/50">
                  <td className="td">
                    <Mono>{shortId(s.id)}</Mono>
                  </td>
                  <td className="td">
                    <Mono className="text-fg">{s.viewerId}</Mono>
                  </td>
                  <td className="td">
                    <Link to={`/videos/${s.videoId}`} className="font-mono text-xs hover:underline">
                      {shortId(s.videoId)}
                    </Link>
                  </td>
                  <td className="td">
                    <StatusDot tone={active ? "ok" : s.revokedAt ? "bad" : "neutral"} label={active ? "Active" : s.revokedAt ? `Revoked${s.revokedReason ? `: ${s.revokedReason}` : ""}` : "Expired"} />
                  </td>
                  <td className="td max-w-[160px] truncate text-muted">{s.origin ?? "-"}</td>
                  <td className="td max-w-[200px] truncate text-xs text-faint" title={s.userAgent ?? ""}>
                    {s.userAgent ?? "-"}
                  </td>
                  <td className="td whitespace-nowrap text-right text-muted">{formatRelative(s.issuedAt)}</td>
                  <td className="td whitespace-nowrap text-right text-muted">{formatRelative(s.expiresAt)}</td>
                  <td className="td text-right">
                    {active && (
                      <Button size="sm" variant="danger" onClick={() => revoke.mutateAsync(s.id).then(() => toast.ok("Session revoked"), (e) => toast.error(errorMessage(e)))}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sessions.data?.data.length === 0 && <Empty title={activeOnly ? "No active sessions" : "No sessions"} description="Sessions appear when a playback token is minted." />}
        {total > LIMIT && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
            <span>{total} sessions</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page * LIMIT >= total} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
