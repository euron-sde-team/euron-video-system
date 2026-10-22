import { settingsStore } from "./settings";

/** Error shape returned by the API: { error: { code, message, requestId, details? } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

const buildUrl = (path: string, query?: Query): string => {
  const { apiBase } = settingsStore.get();
  const url = new URL(`${apiBase}/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
};

/** Thin fetch wrapper: Bearer auth, JSON in/out, typed errors. */
export async function api<T>(method: string, path: string, opts: { body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  const { apiKey } = settingsStore.get();
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      signal: opts.signal,
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Cannot reach the API. Check the base URL and that the server is running.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; requestId?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.requestId, e?.details);
  }
  return json as T;
}

export const get = <T>(path: string, query?: Query) => api<T>("GET", path, { query });
export const post = <T>(path: string, body?: unknown) => api<T>("POST", path, { body: body ?? {} });
export const patch = <T>(path: string, body: unknown) => api<T>("PATCH", path, { body });
export const del = <T = void>(path: string) => api<T>("DELETE", path);

export const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? `${err.message}${err.requestId ? ` (request ${err.requestId})` : ""}` : err instanceof Error ? err.message : "Something went wrong";
