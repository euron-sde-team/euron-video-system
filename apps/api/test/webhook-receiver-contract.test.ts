import { describe, expect, it } from "vitest";
import { verify } from "../../../examples/webhook-receiver/server.mjs";
import { signPayload } from "../src/webhooks/signature.js";

/**
 * Contract test between two independent implementations: the API's signer and
 * the reference receiver users copy. If either drifts, receivers in the wild
 * would start rejecting real deliveries, so this fails CI first.
 */
describe("reference webhook receiver accepts what the dispatcher signs", () => {
  const secret = "whsec_contract_test_0123456789abcdef";
  const body = JSON.stringify({ id: "evt_1", type: "video.ready", data: { videoId: "v1" } });
  const now = 1_767_225_600;

  it("verifies a fresh signature over the raw body", () => {
    expect(verify(secret, body, signPayload(secret, body, now), now)).toBeNull();
  });

  it("rejects a tampered body, a wrong secret and a replayed timestamp", () => {
    const header = signPayload(secret, body, now);
    expect(verify(secret, body.replace("v1", "v2"), header, now)).toBe("signature mismatch");
    expect(verify("whsec_other_secret_0123456789abcdef", body, header, now)).toBe("signature mismatch");
    expect(verify(secret, body, header, now + 301)).toMatch(/possible replay/);
  });

  it("rejects missing or malformed headers", () => {
    expect(verify(secret, body, undefined, now)).toBe("missing EVS-Signature");
    expect(verify(secret, body, "garbage", now)).toBe("malformed EVS-Signature");
  });
});
