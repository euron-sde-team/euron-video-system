import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { type AuditFilters, useAudit } from "../api/hooks";
import { Button, Empty, ErrorNote, Input, Mono, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatDateTime, shortId } from "../lib/format";

export function AuditPage() {
  const [draft, setDraft] = useState<AuditFilters>({});
  const [filters, setFilters] = useState<AuditFilters>({});
  // Cursor stack: forward pagination by cursor, back by popping.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const audit = useAudit(filters, cursor);
  const [open, setOpen] = useState<string | null>(null);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)) as AuditFilters);
    setCursors([null]);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every mutation through the API, attributed to the key that made it. Append-only: the database rejects updates and deletes on this table."
      />
      <form onSubmit={apply} className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="w-56" placeholder="Action, e.g. video.create" value={draft.action ?? ""} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        <Input className="w-44" placeholder="Resource type" value={draft.resourceType ?? ""} onChange={(e) => setDraft({ ...draft, resourceType: e.target.value })} />
        <Input className="w-64 font-mono" placeholder="Resource id" value={draft.resourceId ?? ""} onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })} />
        <Button type="submit">Filter</Button>
      </form>
      {audit.isError && <ErrorNote error={errorMessage(audit.error)} />}
      <Panel flush>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th w-8" />
              <th className="th">Time</th>
              <th className="th">Action</th>
              <th className="th">Resource</th>
              <th className="th">Actor</th>
              <th className="th">Request</th>
            </tr>
          </thead>
          <tbody>
            {audit.isLoading && <SkeletonRows rows={10} cols={6} />}
            {audit.data?.data.map((ev) => (
              <Fragment key={ev.id}>
                <tr className="cursor-pointer hover:bg-raised/50" onClick={() => setOpen(open === ev.id ? null : ev.id)}>
                  <td className="td text-faint">{open === ev.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</td>
                  <td className="td whitespace-nowrap tabular-nums text-muted">{formatDateTime(ev.createdAt)}</td>
                  <td className="td font-mono text-xs">{ev.action}</td>
                  <td className="td">
                    <span className="text-muted">{ev.resource.type}</span> {ev.resource.id && <Mono>{shortId(ev.resource.id)}</Mono>}
                  </td>
                  <td className="td">
                    <span className="text-muted">{ev.actor.type}</span> {ev.actor.id && <Mono>{shortId(ev.actor.id)}</Mono>}
                  </td>
                  <td className="td">
                    <Mono className="text-faint">{ev.requestId ?? "-"}</Mono>
                  </td>
                </tr>
                {open === ev.id && (
                  <tr>
                    <td />
                    <td colSpan={5} className="border-b border-line/70 px-3 pb-3">
                      <pre className="overflow-x-auto rounded-md bg-raised p-3 font-mono text-xs text-muted">{JSON.stringify({ ...ev, metadata: ev.metadata }, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {audit.data?.data.length === 0 && <Empty title="No events" description="Nothing matches these filters." />}
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
          <Button size="sm" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
            Newer
          </Button>
          <Button size="sm" disabled={!audit.data?.nextCursor} onClick={() => audit.data?.nextCursor && setCursors((c) => [...c, audit.data.nextCursor])}>
            Older
          </Button>
        </div>
      </Panel>
    </>
  );
}
