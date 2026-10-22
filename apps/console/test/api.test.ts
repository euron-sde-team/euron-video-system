import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorage } from "./helpers";

type Mod = typeof import("../src/lib/api");
type SettingsMod = typeof import("../src/lib/settings");

let api: Mod;
let settings: SettingsMod;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  vi.resetModules();
  installLocalStorage({ "evs.console.settings": JSON.stringify({ apiBase: "http://api.test:8080/", apiKey: "evs_abcd1234_secret" }) });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  settings = await import("../src/lib/settings");
  api = await import("../src/lib/api");
});

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("sends the API key as a Bearer token to {base}/v1{path} and returns the JSON body", async () => {
    fetchMock.mockResolvedValue(json(200, { apiKey: { id: "k1" } }));
    const res = await api.get<{ apiKey: { id: string } }>("/me");
    expect(res.apiKey.id).toBe("k1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test:8080/v1/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer evs_abcd1234_secret");
    expect(init.method).toBe("GET");
  });

  it("serializes query params, skipping empty values", async () => {
    fetchMock.mockResolvedValue(json(200, { data: [], pagination: { page: 1, limit: 25, total: 0 } }));
    await api.get("/videos", { status: "ready", q: "", page: 2, limit: undefined, active: false });
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "ready", page: "2", active: "false" });
  });

  it("sends JSON bodies with a Content-Type header", async () => {
    fetchMock.mockResolvedValue(json(201, { ok: true }));
    await api.post("/videos", { title: "Intro", filename: "intro.mp4" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Intro", filename: "intro.mp4" });
  });

  it("parses the error envelope into a typed ApiError with code and requestId", async () => {
    fetchMock.mockResolvedValue(json(403, { error: { code: "forbidden", message: "Missing scope videos:write", requestId: "req_123", details: { scope: "videos:write" } } }));
    const err = await api.post("/videos", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({ status: 403, code: "forbidden", message: "Missing scope videos:write", requestId: "req_123", details: { scope: "videos:write" } });
    expect(api.errorMessage(err)).toBe("Missing scope videos:write (request req_123)");
  });

  it("falls back to a generic error for non-JSON failures", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await api.get("/stats").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "http_error", message: "Request failed (502)" });
  });

  it("reports unreachable servers as a network ApiError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await api.get("/me").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network" });
  });

  it("returns undefined for 204 responses", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.del("/api-keys/k1")).resolves.toBeUndefined();
  });

  it("omits the Authorization header when no key is configured", async () => {
    settings.settingsStore.clearKey();
    fetchMock.mockResolvedValue(json(200, {}));
    await api.get("/health");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("settings store", () => {
  it("normalizes the base URL, persists, and notifies subscribers", () => {
    const seen: string[] = [];
    const unsub = settings.settingsStore.subscribe(() => seen.push(settings.settingsStore.get().apiBase));
    settings.settingsStore.set({ apiBase: "https://evs.example.test///" });
    unsub();
    expect(settings.settingsStore.get().apiBase).toBe("https://evs.example.test");
    expect(JSON.parse(localStorage.getItem("evs.console.settings") ?? "{}")).toMatchObject({ apiBase: "https://evs.example.test", apiKey: "evs_abcd1234_secret" });
    expect(seen).toEqual(["https://evs.example.test"]);
  });

  it("recovers from a corrupted stored entry with defaults", async () => {
    vi.resetModules();
    installLocalStorage({ "evs.console.settings": "{not json" });
    const fresh = await import("../src/lib/settings");
    expect(fresh.settingsStore.get()).toEqual({ apiBase: "http://localhost:8080", apiKey: "" });
  });
});
