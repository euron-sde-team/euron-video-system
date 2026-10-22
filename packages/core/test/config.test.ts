import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each test imports a fresh module graph so the memoized getters re-parse. */
const load = async () => {
  vi.resetModules();
  return import("../src/config/index.js");
};

const VALID_API = {
  PUBLIC_API_BASE: "https://api.example.com/",
  API_KEY_PEPPER: "a".repeat(40),
  PLAYBACK_SIGNING_KEYS: `k1=${"b".repeat(40)},k2=${"c".repeat(40)}`,
  PLAYBACK_ACTIVE_KID: "k2",
};

describe("config", () => {
  let snapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    snapshot = { ...process.env };
  });
  afterEach(() => {
    process.env = snapshot;
  });

  it("parses the core slice with safe defaults", async () => {
    const { getCoreConfig } = await load();
    const cfg = getCoreConfig();
    expect(cfg.AWS_REGION).toBe("us-east-1");
    expect(cfg.S3_FORCE_PATH_STYLE).toBe(false);
    expect(cfg.MEDIA_BUCKET).toBe("test-media");
  });

  it("reports every missing required variable at once", async () => {
    delete process.env.MEDIA_BUCKET;
    delete process.env.UPLOADS_BUCKET;
    const { getCoreConfig, ConfigError } = await load();
    try {
      getCoreConfig();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/MEDIA_BUCKET/);
      expect((err as Error).message).toMatch(/UPLOADS_BUCKET/);
    }
  });

  it("accepts secret-based database settings instead of DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    Object.assign(process.env, {
      DATABASE_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:evs-db-example",
      DB_HOST: "db.internal",
      DB_NAME: "evs",
      DB_USER: "evs_admin",
    });
    const { getCoreConfig } = await load();
    expect(getCoreConfig().DB_HOST).toBe("db.internal");
  });

  it("requires one database mode and names what is missing", async () => {
    delete process.env.DATABASE_URL;
    const { getCoreConfig } = await load();
    expect(() => getCoreConfig()).toThrow(/DATABASE_URL: required unless DATABASE_SECRET_ARN/);

    process.env.DATABASE_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:evs-db-example";
    const fresh = await load();
    expect(() => fresh.getCoreConfig()).toThrow(/DB_HOST: required when DATABASE_SECRET_ARN is set/);
  });

  it("parses the playback keyring and normalizes trailing slashes", async () => {
    Object.assign(process.env, VALID_API);
    const { getApiConfig } = await load();
    const cfg = getApiConfig();
    expect([...cfg.PLAYBACK_SIGNING_KEYS.keys()]).toEqual(["k1", "k2"]);
    expect(cfg.PUBLIC_API_BASE).toBe("https://api.example.com");
  });

  it("rejects an active kid that is not in the keyring", async () => {
    Object.assign(process.env, { ...VALID_API, PLAYBACK_ACTIVE_KID: "k9" });
    const { getApiConfig } = await load();
    expect(() => getApiConfig()).toThrow(/PLAYBACK_ACTIVE_KID/);
  });

  it("rejects short signing secrets", async () => {
    Object.assign(process.env, { ...VALID_API, PLAYBACK_SIGNING_KEYS: "k1=short", PLAYBACK_ACTIVE_KID: "k1" });
    const { getApiConfig } = await load();
    expect(() => getApiConfig()).toThrow(/32\+ char/);
  });

  it("allows private webhook targets for local demos but never on AWS", async () => {
    Object.assign(process.env, { ...VALID_API, WEBHOOK_ALLOW_PRIVATE_TARGETS: "true", EVS_CLOUD: "floci" });
    const local = await load();
    expect(local.getApiConfig().WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(true);

    process.env.EVS_CLOUD = "aws";
    const aws = await load();
    expect(() => aws.getApiConfig()).toThrow(/WEBHOOK_ALLOW_PRIVATE_TARGETS: not allowed when EVS_CLOUD=aws/);
  });

  it("requires CloudFront settings for cloudfront-signed delivery", async () => {
    Object.assign(process.env, { ...VALID_API, DELIVERY_DRIVER: "cloudfront-signed" });
    const { getApiConfig } = await load();
    expect(() => getApiConfig()).toThrow(/CLOUDFRONT_KEY_PAIR_ID/);
  });

  it("refuses placeholder secrets in production", async () => {
    Object.assign(process.env, {
      ...VALID_API,
      NODE_ENV: "production",
      API_KEY_PEPPER: "change-me-change-me-change-me-change-me",
    });
    const { getApiConfig } = await load();
    expect(() => getApiConfig()).toThrow(/placeholder/);
  });

  it("requires launch settings only for the ec2-spot launcher", async () => {
    const { getOrchestratorConfig } = await load();
    expect(() => getOrchestratorConfig()).toThrow(/LAUNCH_TEMPLATE_NAME/);

    process.env.LAUNCHER = "noop";
    const fresh = await load();
    expect(fresh.getOrchestratorConfig().LAUNCHER).toBe("noop");
  });
});
