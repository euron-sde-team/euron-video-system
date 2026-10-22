import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useApiKeys, useCreateApiKey, useMe, useRevokeApiKey } from "../api/hooks";
import { useToast } from "../components/toast";
import { Button, Checkbox, ConfirmDialog, CopyField, Dialog, Empty, ErrorNote, Field, Input, Mono, PageHeader, Panel, SkeletonRows, StatusDot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatRelative } from "../lib/format";
import { type ApiKey, SCOPES } from "../lib/types";

export function ApiKeysPage() {
  const keys = useApiKeys();
  const me = useMe();
  const revoke = useRevokeApiKey();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys authenticate server-to-server calls. Each carries explicit scopes; only a keyed hash is stored, so a lost key cannot be recovered, only replaced."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
      />
      {keys.isError && <ErrorNote error={errorMessage(keys.error)} />}
      <Panel flush>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Prefix</th>
              <th className="th">Scopes</th>
              <th className="th">State</th>
              <th className="th text-right">Last used</th>
              <th className="th text-right">Created</th>
              <th className="th w-20" />
            </tr>
          </thead>
          <tbody>
            {keys.isLoading && <SkeletonRows rows={3} cols={7} />}
            {keys.data?.data.map((k) => {
              const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
              const current = me.data?.apiKey.id === k.id;
              return (
                <tr key={k.id} className="hover:bg-raised/50">
                  <td className="td font-medium">
                    {k.name}
                    {current && <span className="ml-2 text-2xs font-normal uppercase tracking-wide text-faint">This console</span>}
                  </td>
                  <td className="td">
                    <Mono>evs_{k.prefix}_...</Mono>
                  </td>
                  <td className="td max-w-[300px] truncate font-mono text-xs text-muted" title={k.scopes.join(" ")}>
                    {k.scopes.includes("*") ? "* (all)" : k.scopes.join(" ")}
                  </td>
                  <td className="td">
                    <StatusDot tone={k.revokedAt ? "bad" : expired ? "neutral" : "ok"} label={k.revokedAt ? "Revoked" : expired ? "Expired" : "Active"} />
                  </td>
                  <td className="td text-right text-muted">{k.lastUsedAt ? formatRelative(k.lastUsedAt) : "Never"}</td>
                  <td className="td text-right text-muted">{formatRelative(k.createdAt)}</td>
                  <td className="td text-right">
                    {!k.revokedAt && (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {keys.data?.data.length === 0 && <Empty title="No keys" />}
      </Panel>

      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revoke API key"
        description={
          me.data?.apiKey.id === revoking?.id
            ? "This is the key this console is using. Revoking it disconnects the console immediately."
            : `Calls using "${revoking?.name}" start failing with 401 immediately. This cannot be undone.`
        }
        danger
        confirmLabel="Revoke key"
        loading={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutateAsync(revoking.id).then(
            () => {
              setRevoking(null);
              toast.ok("Key revoked");
            },
            (err) => toast.error(errorMessage(err))
          )
        }
      />
    </>
  );
}

function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateApiKey();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["videos:read", "playback:mint"]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [secret, setSecret] = useState<string | null>(null);

  const toggle = (s: string, on: boolean) => setScopes((xs) => (on ? [...new Set([...xs, s])] : xs.filter((x) => x !== s)));
  const all = scopes.includes("*");

  const submit = () => {
    const days = Number(expiresInDays);
    create
      .mutateAsync({
        name: name.trim(),
        scopes,
        ...(days > 0 ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
      })
      .then(
        (res) => setSecret(res.secret),
        (err) => toast.error(errorMessage(err))
      );
  };

  if (secret) {
    return (
      <Dialog open onClose={onClose} title="Key created" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="mb-3 flex items-start gap-2 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Copy this key now. It is shown once and cannot be retrieved later.</span>
        </div>
        <CopyField value={secret} secret />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create API key"
      description="Grant the narrowest scopes the caller needs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim() || scopes.length === 0} onClick={submit}>
            Create key
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="backend-production" autoFocus />
        </Field>
        <Field label="Expires after (days)" hint="Leave empty for a key that never expires.">
          <Input type="number" min={1} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
        </Field>
        <div>
          <span className="label">Scopes</span>
          <div className="rounded-md border border-line px-3 py-2">
            <Checkbox checked={all} onChange={(v) => setScopes(v ? ["*"] : [])} label={<span className="font-mono text-xs">*</span>} description="Every scope, including managing other keys" />
            <div className={all ? "pointer-events-none opacity-40" : ""}>
              {SCOPES.map((s) => (
                <Checkbox key={s.id} checked={all || scopes.includes(s.id)} onChange={(v) => toggle(s.id, v)} label={<span className="font-mono text-xs">{s.id}</span>} description={s.label} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
