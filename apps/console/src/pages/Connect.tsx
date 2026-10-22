import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Logo } from "../components/Layout";
import { Button, ErrorNote, Field, Input, Kbd } from "../components/ui";
import { errorMessage, get } from "../lib/api";
import { settingsStore, useSettings } from "../lib/settings";
import type { Me } from "../lib/types";

/** Shown until the console holds an API key the server accepts. */
export function ConnectPage({ rejected }: { rejected?: boolean }) {
  const settings = useSettings();
  const qc = useQueryClient();
  const [apiBase, setApiBase] = useState(settings.apiBase);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(rejected ? "The saved API key was rejected. It may have been revoked or expired." : null);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const previous = settingsStore.get();
    settingsStore.set({ apiBase, apiKey: apiKey.trim() });
    try {
      await get<Me>("/me");
      await qc.invalidateQueries();
    } catch (err) {
      settingsStore.set(previous.apiKey ? { ...previous, apiKey: "" } : previous);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="h-8 w-8" />
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Euron Video System</div>
            <div className="text-xs text-muted">Connect the console to your control plane</div>
          </div>
        </div>
        <form onSubmit={connect} className="space-y-4 rounded-lg border border-line bg-surface p-5">
          <Field label="API base URL">
            <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://localhost:8080" required />
          </Field>
          <Field label="API key" hint="Stored only in this browser. Revoke it from API keys when you are done.">
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="evs_..." autoComplete="off" spellCheck={false} className="font-mono" required />
          </Field>
          {error && <ErrorNote error={error} />}
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Connect
          </Button>
        </form>
        <p className="mt-5 text-xs leading-relaxed text-muted">
          No key yet? Create one with the CLI: <Kbd>pnpm evs keys:create --name console --scopes &apos;*&apos;</Kbd>. The local demo (<Kbd>make demo</Kbd>) prints one for you.
        </p>
      </div>
    </div>
  );
}
