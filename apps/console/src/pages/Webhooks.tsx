import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useCreateWebhook, useDeleteWebhook, useDeliveries, useRedeliver, useTestWebhook, useUpdateWebhook, useWebhooks } from "../api/hooks";
import { useToast } from "../components/toast";
import { Button, Checkbox, ConfirmDialog, CopyField, Dialog, Empty, ErrorNote, Field, Input, Mono, PageHeader, Panel, SkeletonRows, StatusDot, Switch, type Tone } from "../components/ui";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { formatRelative } from "../lib/format";
import { EVENT_TYPES, type Webhook, type WebhookDelivery } from "../lib/types";

const DELIVERY_TONE: Record<WebhookDelivery["status"], Tone> = { pending: "warn", delivering: "info", delivered: "ok", failed: "bad" };

export function WebhooksPage() {
  const hooks = useWebhooks();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = hooks.data?.data.find((h) => h.id === selected) ?? hooks.data?.data[0] ?? null;

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Signed HTTPS callbacks for pipeline events. Events are written to an outbox in the same transaction as the state change, then delivered with exponential backoff."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add endpoint
          </Button>
        }
      />
      {hooks.isError && <ErrorNote error={errorMessage(hooks.error)} />}
      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Panel title="Endpoints" flush>
          {hooks.isLoading && <div className="h-24 animate-pulse" />}
          {hooks.data?.data.length === 0 && <Empty title="No endpoints" description="Add an endpoint to receive video.ready and friends." />}
          <ul className="divide-y divide-line/70">
            {hooks.data?.data.map((h) => (
              <li key={h.id}>
                <button onClick={() => setSelected(h.id)} className={cn("w-full px-4 py-3 text-left transition-colors", current?.id === h.id ? "bg-raised" : "hover:bg-raised/50")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{h.url}</span>
                    <StatusDot tone={h.enabled ? "ok" : "neutral"} label="" />
                  </div>
                  <div className="mt-1 truncate text-xs text-faint">{h.description || `${h.events.length} event type${h.events.length === 1 ? "" : "s"}`}</div>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        {current ? <EndpointDetail hook={current} /> : <div />}
      </div>
      {creating && <CreateWebhookDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function EndpointDetail({ hook }: { hook: Webhook }) {
  const update = useUpdateWebhook();
  const test = useTestWebhook();
  const remove = useDeleteWebhook();
  const deliveries = useDeliveries(hook.id);
  const redeliver = useRedeliver();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="min-w-0 space-y-6">
      <Panel
        title={<span className="font-mono text-xs">{hook.url}</span>}
        actions={
          <>
            <span className="flex items-center gap-2 text-xs text-muted">
              {hook.enabled ? "Enabled" : "Disabled"}
              <Switch
                label="Enabled"
                checked={hook.enabled}
                disabled={update.isPending}
                onChange={(enabled) => update.mutateAsync({ id: hook.id, enabled }).catch((e) => toast.error(errorMessage(e)))}
              />
            </span>
            <Button size="sm" loading={test.isPending} onClick={() => test.mutateAsync(hook.id).then(() => toast.ok("Test event queued"), (e) => toast.error(errorMessage(e)))}>
              Send test
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted">
          {hook.events.map((e) => (
            <span key={e}>{e === "*" ? "* (all events)" : e}</span>
          ))}
        </div>
        <p className="mt-3 text-xs text-faint">
          Verify each request: <Mono>EVS-Signature: t=timestamp,v1=hex</Mono> is HMAC-SHA256 of <Mono>{"<timestamp>.<raw body>"}</Mono> with the endpoint&apos;s signing secret. Reject timestamps older than five minutes.
        </p>
      </Panel>

      <Panel title="Recent deliveries" flush>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Event</th>
              <th className="th">Status</th>
              <th className="th text-right">Attempts</th>
              <th className="th">Response</th>
              <th className="th text-right">Created</th>
              <th className="th w-24" />
            </tr>
          </thead>
          <tbody>
            {deliveries.isLoading && <SkeletonRows rows={4} cols={6} />}
            {deliveries.data?.data.map((d) => (
              <tr key={d.id} className="hover:bg-raised/50">
                <td className="td">
                  <div className="font-mono text-xs">{d.eventType}</div>
                  <Mono className="text-2xs text-faint">{d.eventId}</Mono>
                </td>
                <td className="td">
                  <StatusDot tone={DELIVERY_TONE[d.status]} label={d.status === "pending" && d.attempts > 0 ? `Retrying ${formatRelative(d.nextAttemptAt)}` : d.status[0]?.toUpperCase() + d.status.slice(1)} />
                </td>
                <td className="td text-right tabular-nums">{d.attempts}</td>
                <td className="td max-w-[220px] truncate text-xs text-muted" title={d.lastError ?? ""}>
                  {d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : ""}
                  {d.lastError ? `${d.lastStatusCode ? " / " : ""}${d.lastError}` : ""}
                  {!d.lastStatusCode && !d.lastError ? "-" : ""}
                </td>
                <td className="td whitespace-nowrap text-right text-muted">{formatRelative(d.createdAt)}</td>
                <td className="td text-right">
                  {(d.status === "failed" || d.status === "delivered") && (
                    <Button size="sm" variant="ghost" onClick={() => redeliver.mutateAsync(d.id).then(() => toast.ok("Redelivery queued"), (e) => toast.error(errorMessage(e)))}>
                      Redeliver
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {deliveries.data?.data.length === 0 && <Empty title="No deliveries yet" description="Send a test event, or wait for the next pipeline event." />}
      </Panel>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete endpoint"
        description="Pending deliveries to this endpoint are discarded."
        danger
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutateAsync(hook.id).then(
            () => {
              setConfirmDelete(false);
              toast.ok("Endpoint deleted");
            },
            (e) => toast.error(errorMessage(e))
          )
        }
      />
    </div>
  );
}

function CreateWebhookDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateWebhook();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["video.ready", "video.failed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const all = events.includes("*");

  if (secret) {
    return (
      <Dialog open onClose={onClose} title="Endpoint added" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="mb-3 flex items-start gap-2 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Store this signing secret in your receiver. It is shown once.</span>
        </div>
        <CopyField value={secret} secret />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add webhook endpoint"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!url.trim() || events.length === 0}
            onClick={() =>
              create.mutateAsync({ url: url.trim(), events, ...(description.trim() ? { description: description.trim() } : {}) }).then(
                (res) => setSecret(res.signingSecret),
                (e) => toast.error(errorMessage(e))
              )
            }
          >
            Add endpoint
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Endpoint URL" hint="HTTPS in production.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/hooks/video" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </Field>
        <div>
          <span className="label">Events</span>
          <div className="rounded-md border border-line px-3 py-2">
            <Checkbox checked={all} onChange={(v) => setEvents(v ? ["*"] : [])} label={<span className="font-mono text-xs">*</span>} description="Every event, including types added later" />
            <div className={cn("grid grid-cols-2", all && "pointer-events-none opacity-40")}>
              {EVENT_TYPES.map((e) => (
                <Checkbox key={e} checked={all || events.includes(e)} onChange={(v) => setEvents((xs) => (v ? [...new Set([...xs, e])] : xs.filter((x) => x !== e)))} label={<span className="font-mono text-xs">{e}</span>} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
