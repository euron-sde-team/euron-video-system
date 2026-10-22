import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudFrontSignedDriver, PresignedDriver, ProxyDriver, PublicDriver } from "../src/delivery/index.js";

/** CloudFront's URL-safe base64 alphabet: + -> -, = -> _, / -> ~ */
const fromCloudFrontBase64 = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");

describe("cloudfront-signed delivery", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const driver = new CloudFrontSignedDriver("https://media.example.com", "K2EXAMPLEKEYID", pem);

  it("signs ONE wildcard policy scoped to the video and appends it to every URL", async () => {
    const urls = await driver.urlsFor("vid123", ["hls/720/seg_00000.ts", "hls/720/seg_00001.ts"], 120, "unused");
    expect(urls).toHaveLength(2);
    const queries = urls.map((u) => new URL(u).search);
    expect(queries[0]).toBe(queries[1]); // one signature for the whole batch
    const u = new URL(urls[0] as string);
    expect(u.origin + u.pathname).toBe("https://media.example.com/media/vid123/hls/720/seg_00000.ts");
    expect(u.searchParams.get("Key-Pair-Id")).toBe("K2EXAMPLEKEYID");

    const policyJson = fromCloudFrontBase64(u.searchParams.get("Policy") as string).toString("utf8");
    const policy = JSON.parse(policyJson) as {
      Statement: Array<{ Resource: string; Condition: { DateLessThan: { "AWS:EpochTime": number } } }>;
    };
    const stmt = policy.Statement[0]!;
    expect(stmt.Resource).toBe("https://media.example.com/media/vid123/*");
    const exp = stmt.Condition.DateLessThan["AWS:EpochTime"];
    expect(exp).toBeGreaterThan(Date.now() / 1000 + 100);
    expect(exp).toBeLessThanOrEqual(Date.now() / 1000 + 121);

    // The signature verifies against the public key over the exact policy bytes.
    const verify = createVerify(u.searchParams.get("Hash-Algorithm") === "SHA256" ? "RSA-SHA256" : "RSA-SHA1");
    verify.update(policyJson);
    expect(verify.verify(publicKey, fromCloudFrontBase64(u.searchParams.get("Signature") as string))).toBe(true);
  });
});

describe("presigned delivery", () => {
  it("produces SigV4 presigned GETs for each object with the token's remaining TTL", async () => {
    const urls = await new PresignedDriver().urlsFor("vid123", ["hls/720/seg_00000.ts", "poster.jpg"], 90, "unused");
    expect(urls).toHaveLength(2);
    const u = new URL(urls[0] as string);
    expect(u.pathname).toContain("media/vid123/hls/720/seg_00000.ts");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("90");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("proxy and public delivery", () => {
  it("proxy routes through the API with the token", async () => {
    const [url] = await new ProxyDriver("https://api.example.com").urlsFor("vid", ["hls/720/seg 1.ts"], 60, "tok/en");
    expect(url).toBe("https://api.example.com/v1/play/vid/media/hls/720/seg%201.ts?token=tok%2Fen");
  });
  it("public is a plain base URL", async () => {
    const [url] = await new PublicDriver("https://cdn.example.com").urlsFor("vid", ["poster.jpg"], 60, "t");
    expect(url).toBe("https://cdn.example.com/media/vid/poster.jpg");
  });
});
