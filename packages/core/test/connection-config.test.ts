import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASSWORD_CACHE_MS,
  fetchSecretPassword,
  resetPasswordCache,
  resolveConnectionConfig,
  usesSecretCredentials,
} from "../src/db/connection-config.js";

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:evs-db-example";
const SECRET_ENV = { DATABASE_SECRET_ARN: ARN, DB_HOST: "db.internal", DB_NAME: "evs", DB_USER: "evs_admin" };

/** A fake Secrets Manager whose stored password can be "rotated" mid-test. */
const fakeSecretsManager = (initial: string) => {
  let current = initial;
  const send = vi.fn(async () => ({ SecretString: JSON.stringify({ username: "evs_admin", password: current }) }));
  return { sm: { send } as never, send, rotate: (next: string) => (current = next) };
};

beforeEach(resetPasswordCache);

describe("resolveConnectionConfig", () => {
  it("prefers DATABASE_URL when both modes are configured", () => {
    const cfg = resolveConnectionConfig({ DATABASE_URL: "postgres://u:p@h:5432/d", ...SECRET_ENV });
    expect(cfg).toEqual({ connectionString: "postgres://u:p@h:5432/d" });
    expect(usesSecretCredentials({ DATABASE_URL: "postgres://u:p@h/d", ...SECRET_ENV })).toBe(false);
  });

  it("builds a secret-based config whose password is resolved lazily", () => {
    const cfg = resolveConnectionConfig({ ...SECRET_ENV, DB_PORT: "6543" });
    expect(cfg).toMatchObject({ host: "db.internal", port: 6543, database: "evs", user: "evs_admin" });
    expect(typeof cfg.password).toBe("function");
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(usesSecretCredentials(SECRET_ENV)).toBe(true);
  });

  it("defaults the port to 5432", () => {
    expect(resolveConnectionConfig(SECRET_ENV).port).toBe(5432);
  });

  it("names every missing setting", () => {
    expect(() => resolveConnectionConfig({ DATABASE_SECRET_ARN: ARN })).toThrow(/DB_HOST, DB_NAME, DB_USER/);
  });

  it("fails clearly when neither mode is configured", () => {
    expect(() => resolveConnectionConfig({})).toThrow(/DATABASE_URL, or DATABASE_SECRET_ARN/);
  });

  it("supports disabling TLS and rejects unknown modes", () => {
    expect(resolveConnectionConfig({ ...SECRET_ENV, DB_SSL: "disable" }).ssl).toBe(false);
    expect(() => resolveConnectionConfig({ ...SECRET_ENV, DB_SSL: "maybe" })).toThrow(/DB_SSL must be/);
    expect(() => resolveConnectionConfig({ ...SECRET_ENV, DB_SSL: "verify-full" })).toThrow(/DB_SSL_CA_FILE/);
  });
});

describe("fetchSecretPassword", () => {
  it("caches the password for PASSWORD_CACHE_MS", async () => {
    const { sm, send } = fakeSecretsManager("first");
    const t0 = Date.now();
    expect(await fetchSecretPassword(ARN, "us-east-1", t0, sm)).toBe("first");
    expect(await fetchSecretPassword(ARN, "us-east-1", t0 + PASSWORD_CACHE_MS - 1, sm)).toBe("first");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("picks up a rotated password once the cache expires, without a restart", async () => {
    const { sm, send, rotate } = fakeSecretsManager("before-rotation");
    const t0 = Date.now();
    expect(await fetchSecretPassword(ARN, "us-east-1", t0, sm)).toBe("before-rotation");

    rotate("after-rotation");
    // Inside the window the cached password is still served...
    expect(await fetchSecretPassword(ARN, "us-east-1", t0 + 1_000, sm)).toBe("before-rotation");
    // ...and the first connection after it gets the new one.
    expect(await fetchSecretPassword(ARN, "us-east-1", t0 + PASSWORD_CACHE_MS + 1, sm)).toBe("after-rotation");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request when a pool opens many connections at once", async () => {
    const { sm, send } = fakeSecretsManager("shared");
    const results = await Promise.all(Array.from({ length: 10 }, () => fetchSecretPassword(ARN, "us-east-1", Date.now(), sm)));
    expect(new Set(results)).toEqual(new Set(["shared"]));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures: the next connection retries", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ password: "ok" }) });
    await expect(fetchSecretPassword(ARN, "us-east-1", Date.now(), { send } as never)).rejects.toThrow("throttled");
    await expect(fetchSecretPassword(ARN, "us-east-1", Date.now(), { send } as never)).resolves.toBe("ok");
  });

  it("rejects a secret without a password", async () => {
    const send = vi.fn(async () => ({ SecretString: JSON.stringify({ username: "evs_admin" }) }));
    await expect(fetchSecretPassword(ARN, "us-east-1", Date.now(), { send } as never)).rejects.toThrow(/no password/);
  });
});
