import { useSyncExternalStore } from "react";

/**
 * Console connection settings, persisted in localStorage. The API key lives in
 * the browser of the operator who pasted it, so use a key scoped to what the
 * console needs and revoke it when done. Never ship a key in a build.
 */
export interface ConsoleSettings {
  apiBase: string;
  apiKey: string;
}

const KEY = "evs.console.settings";
const DEFAULT_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

const normalizeBase = (base: string): string => base.trim().replace(/\/+$/, "");

const read = (): ConsoleSettings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConsoleSettings>;
      return { apiBase: normalizeBase(parsed.apiBase || DEFAULT_BASE), apiKey: parsed.apiKey ?? "" };
    }
  } catch {
    /* corrupted entry: fall through to defaults */
  }
  return { apiBase: normalizeBase(DEFAULT_BASE), apiKey: "" };
};

let current = read();
const listeners = new Set<() => void>();

export const settingsStore = {
  get: (): ConsoleSettings => current,
  set(next: Partial<ConsoleSettings>) {
    current = { ...current, ...next, apiBase: normalizeBase(next.apiBase ?? current.apiBase) };
    localStorage.setItem(KEY, JSON.stringify(current));
    listeners.forEach((l) => l());
  },
  clearKey() {
    settingsStore.set({ apiKey: "" });
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const useSettings = (): ConsoleSettings => useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
