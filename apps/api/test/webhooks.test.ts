import { describe, expect, it } from "vitest";
import { nextRetryDelay } from "../src/webhooks/retry.js";
import { signPayload, verifySignature } from "../src/webhooks/signature.js";
import { assertSafeWebhookUrl, isPrivateAddress } from "../src/webhooks/ssrf.js";

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "video.ready" });

  it("signs t.<body> and verifies within tolerance", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, body, header, 1_700_000_100)).toBe(true);
  });

  it("rejects a modified body, a wrong secret and a replay outside tolerance", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(verifySignature(secret, `${body} `, header, 1_700_000_000)).toBe(false);
    expect(verifySignature("other", body, header, 1_700_000_000)).toBe(false);
    expect(verifySignature(secret, body, header, 1_700_000_000 + 301)).toBe(false);
  });
});

describe("retry schedule", () => {
  it("backs off exponentially with jitter between half and full delay", () => {
    expect(nextRetryDelay(1, () => 0)).toBe(15_000);
    expect(nextRetryDelay(1, () => 1)).toBe(30_000);
    expect(nextRetryDelay(2, () => 1)).toBe(60_000);
    expect(nextRetryDelay(3, () => 1)).toBe(120_000);
  });
  it("caps at one hour", () => {
    expect(nextRetryDelay(30, () => 1)).toBe(3_600_000);
    expect(nextRetryDelay(30, () => 0)).toBe(1_800_000);
  });
});

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "classifies %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1"])("classifies %s as public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  );

  it("enforced: requires https and refuses names resolving to private space", async () => {
    await expect(assertSafeWebhookUrl("http://example.com/h", true, async () => ["93.184.216.34"])).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl("https://internal.example.com/h", true, async () => ["10.0.0.5"])).rejects.toThrow(
      /non-public/
    );
    await expect(assertSafeWebhookUrl("https://169.254.169.254/latest", true)).rejects.toThrow(/non-public/);
    await expect(assertSafeWebhookUrl("https://user:pw@example.com/h", true)).rejects.toThrow(/credentials/);
    await expect(assertSafeWebhookUrl("https://hooks.example.com/h", true, async () => ["93.184.216.34"])).resolves.toBeUndefined();
  });

  it("not enforced (development): localhost receivers are allowed", async () => {
    await expect(assertSafeWebhookUrl("http://localhost:9000/h", false)).resolves.toBeUndefined();
    await expect(assertSafeWebhookUrl("ftp://localhost/h", false)).rejects.toThrow(/http/);
  });
});
