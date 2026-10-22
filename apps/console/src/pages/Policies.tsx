import { useState } from "react";
import { type PolicyInput, useDeletePolicy, usePolicies, useSavePolicy } from "../api/hooks";
import { useToast } from "../components/toast";
import { Button, Checkbox, ConfirmDialog, Dialog, Empty, ErrorNote, Field, Input, PageHeader, Panel, SkeletonRows, StatusDot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatRelative } from "../lib/format";
import type { PlaybackPolicy } from "../lib/types";

const BLANK: PolicyInput = {
  name: "",
  isDefault: false,
  tokenTtlSeconds: 300,
  maxTokenTtlSeconds: 3600,
  allowedOrigins: [],
  maxConcurrentSessions: 0,
  watermarkRequired: true,
  allowDownload: false,
};

export function PoliciesPage() {
  const policies = usePolicies();
  const remove = useDeletePolicy();
  const toast = useToast();
  const [editing, setEditing] = useState<(PolicyInput & { id?: string }) | null>(null);
  const [deleting, setDeleting] = useState<PlaybackPolicy | null>(null);

  return (
    <>
      <PageHeader
        title="Playback policies"
        description="Rules every playback token is minted under: token lifetime, which origins may play, how many sessions a viewer may hold at once, watermarking and downloads."
        actions={
          <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>
            New policy
          </Button>
        }
      />
      {policies.isError && <ErrorNote error={errorMessage(policies.error)} onRetry={() => void policies.refetch()} />}
      <Panel flush>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th text-right">Token TTL</th>
              <th className="th text-right">Max TTL</th>
              <th className="th">Origins</th>
              <th className="th text-right">Concurrency</th>
              <th className="th">Watermark</th>
              <th className="th">Download</th>
              <th className="th text-right">Updated</th>
              <th className="th w-32" />
            </tr>
          </thead>
          <tbody>
            {policies.isLoading && <SkeletonRows rows={3} cols={9} />}
            {policies.data?.data.map((p) => (
              <tr key={p.id} className="hover:bg-raised/50">
                <td className="td font-medium">
                  {p.name}
                  {p.isDefault && <span className="ml-2 text-2xs font-normal uppercase tracking-wide text-faint">Default</span>}
                </td>
                <td className="td text-right tabular-nums">{p.tokenTtlSeconds}s</td>
                <td className="td text-right tabular-nums text-muted">{p.maxTokenTtlSeconds}s</td>
                <td className="td max-w-[220px] truncate text-muted" title={p.allowedOrigins.join(", ")}>
                  {p.allowedOrigins.length ? p.allowedOrigins.join(", ") : "Any"}
                </td>
                <td className="td text-right tabular-nums">{p.maxConcurrentSessions || "Unlimited"}</td>
                <td className="td">
                  <StatusDot tone={p.watermarkRequired ? "ok" : "neutral"} label={p.watermarkRequired ? "Required" : "Off"} />
                </td>
                <td className="td">
                  <StatusDot tone={p.allowDownload ? "warn" : "neutral"} label={p.allowDownload ? "Allowed" : "Blocked"} />
                </td>
                <td className="td text-right text-muted">{formatRelative(p.updatedAt)}</td>
                <td className="td text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...p })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" disabled={p.isDefault} onClick={() => setDeleting(p)}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {policies.data?.data.length === 0 && <Empty title="No policies" description="Create a policy to control how videos are played." />}
      </Panel>

      {editing && <PolicyDialog initial={editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete policy"
        description={`Videos using "${deleting?.name}" fall back to the default policy.`}
        danger
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutateAsync(deleting.id).then(
            () => {
              setDeleting(null);
              toast.ok("Policy deleted");
            },
            (err) => toast.error(errorMessage(err))
          )
        }
      />
    </>
  );
}

function PolicyDialog({ initial, onClose }: { initial: PolicyInput & { id?: string }; onClose: () => void }) {
  const [form, setForm] = useState(initial);
  const [origins, setOrigins] = useState(initial.allowedOrigins.join("\n"));
  const save = useSavePolicy();
  const toast = useToast();
  const set = <K extends keyof PolicyInput>(k: K, v: PolicyInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const allowedOrigins = origins
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    save.mutateAsync({ ...form, allowedOrigins }).then(
      () => {
        toast.ok(form.id ? "Policy updated" : "Policy created");
        onClose();
      },
      (err) => toast.error(errorMessage(err))
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={form.id ? "Edit policy" : "New policy"}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={submit}>
            {form.id ? "Save changes" : "Create policy"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="members-only" autoFocus />
          </Field>
        </div>
        <Field label="Default token TTL (s)" hint="10 to 86400">
          <Input type="number" min={10} max={86400} value={form.tokenTtlSeconds} onChange={(e) => set("tokenTtlSeconds", Number(e.target.value))} />
        </Field>
        <Field label="Max token TTL (s)" hint="Upper bound callers may request">
          <Input type="number" min={10} max={86400} value={form.maxTokenTtlSeconds} onChange={(e) => set("maxTokenTtlSeconds", Number(e.target.value))} />
        </Field>
        <Field label="Max concurrent sessions" hint="Per viewer. 0 = unlimited">
          <Input type="number" min={0} value={form.maxConcurrentSessions} onChange={(e) => set("maxConcurrentSessions", Number(e.target.value))} />
        </Field>
        <div />
        <div className="col-span-2">
          <Field label="Allowed origins" hint="One per line, exact match (https://app.example.com). Empty allows any origin.">
            <textarea className="input h-20 py-1.5 font-mono text-xs" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2 space-y-1">
          <Checkbox checked={form.watermarkRequired} onChange={(v) => set("watermarkRequired", v)} label="Require a viewer watermark" description="The player overlays the viewer id, moving every few seconds." />
          <Checkbox checked={form.allowDownload} onChange={(v) => set("allowDownload", v)} label="Allow MP4 download" description="Lets callers mint presigned links to the processed MP4." />
          <Checkbox checked={form.isDefault} onChange={(v) => set("isDefault", v)} label="Make this the default policy" />
        </div>
      </div>
    </Dialog>
  );
}
