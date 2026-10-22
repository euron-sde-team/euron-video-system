/** Human byte sizes: 1.4 GB, 720 MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Duration: 1:02:03 or 4:05. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Compact relative time: just now, 3m ago, 2h ago, 5d ago. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  const future = diff < 0;
  const sec = Math.round(Math.abs(diff) / 1000);
  const fmt = (n: number, u: string) => (future ? `in ${n}${u}` : `${n}${u} ago`);
  if (sec < 45) return future ? "in a moment" : "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return fmt(min, "m");
  const hr = Math.round(min / 60);
  if (hr < 24) return fmt(hr, "h");
  const day = Math.round(hr / 24);
  if (day < 30) return fmt(day, "d");
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatNumber(n: number | null | undefined): string {
  return n == null ? "-" : new Intl.NumberFormat().format(n);
}

/** Compact seconds as hours/minutes for usage totals: 12.4 h, 38 min. */
export function formatMinutes(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.round(seconds / 60)} min`;
}

export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id);

/** Human label for an API key's scopes: "all scopes" for "*", else a correctly pluralized count. */
export function describeScopes(scopes: readonly string[]): string {
  if (scopes.includes("*")) return "all scopes";
  return `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;
}
