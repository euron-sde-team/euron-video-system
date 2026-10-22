import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMe } from "../api/hooks";
import { useToast } from "../components/toast";
import { Button, DefinitionList, ErrorNote, Field, Input, Mono, PageHeader, Panel, StatusDot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { settingsStore, useSettings } from "../lib/settings";

export function SettingsPage() {
  const settings = useSettings();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [apiBase, setApiBase] = useState(settings.apiBase);
  const [apiKey, setApiKey] = useState(settings.apiKey);

  const save = async () => {
    settingsStore.set({ apiBase, apiKey: apiKey.trim() });
    await qc.invalidateQueries();
    toast.ok("Connection settings saved");
  };

  return (
    <>
      <PageHeader title="Settings" description="Where this console connects, and what the current key may do." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Connection">
          <div className="space-y-4">
            <Field label="API base URL">
              <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
            </Field>
            <Field label="API key" hint="Kept in this browser's localStorage only.">
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="font-mono" autoComplete="off" />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void save()}>
                Save
              </Button>
              <Button onClick={() => void me.refetch()} loading={me.isFetching}>
                Test connection
              </Button>
              <Button variant="ghost" className="ml-auto" onClick={() => settingsStore.clearKey()}>
                Disconnect
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Current key">
          {me.isError && <ErrorNote error={errorMessage(me.error)} />}
          {me.data && (
            <>
              <DefinitionList
                items={[
                  ["Status", <StatusDot key="s" tone="ok" label="Connected" />],
                  ["Name", me.data.apiKey.name],
                  ["Prefix", <Mono key="p">{me.data.apiKey.prefix}</Mono>],
                  ["Created", formatDateTime(me.data.apiKey.createdAt)],
                  ["Expires", me.data.apiKey.expiresAt ? formatDateTime(me.data.apiKey.expiresAt) : "Never"],
                ]}
              />
              <div className="mt-4">
                <div className="label">Granted scopes</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                  {me.data.apiKey.scopes.map((s) => (
                    <span key={s}>{s === "*" ? "* (all scopes)" : s}</span>
                  ))}
                </div>
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
