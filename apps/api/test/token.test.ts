import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { PLAYBACK_AUDIENCE, signPlaybackToken, verifyPlaybackToken, type Keyring } from "../src/playback/token.js";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const ring = (keys: Record<string, string>, activeKid: string): Keyring => ({
  keys: new Map(Object.entries(keys)),
  activeKid,
  issuer: "evs",
});
const input = { viewerId: "viewer-1", videoId: "vid-1", sessionId: "ps_1", ttlSeconds: 60 };

describe("playback tokens", () => {
  it("round-trips claims and carries the kid in the header", () => {
    const r = ring({ k1: SECRET_A }, "k1");
    const token = signPlaybackToken(r, input);
    const header = (jwt.decode(token, { complete: true }) as { header: { kid: string; alg: string } }).header;
    expect(header).toMatchObject({ kid: "k1", alg: "HS256" });
    expect(verifyPlaybackToken(r, token)).toMatchObject({
      sub: "viewer-1",
      vid: "vid-1",
      jti: "ps_1",
      iss: "evs",
      aud: PLAYBACK_AUDIENCE,
    });
  });

  it("supports zero-downtime rotation: old-kid tokens verify while the old key stays in the ring", () => {
    const old = signPlaybackToken(ring({ k1: SECRET_A }, "k1"), input);
    const rotated = ring({ k1: SECRET_A, k2: SECRET_B }, "k2");
    expect(verifyPlaybackToken(rotated, old).jti).toBe("ps_1");
    const fresh = signPlaybackToken(rotated, input);
    expect((jwt.decode(fresh, { complete: true }) as { header: { kid: string } }).header.kid).toBe("k2");
    // Once the old key is dropped, its tokens stop verifying.
    expect(() => verifyPlaybackToken(ring({ k2: SECRET_B }, "k2"), old)).toThrow(/Invalid playback token/);
  });

  it("rejects an unknown kid, a tampered signature and the wrong audience", () => {
    const r = ring({ k1: SECRET_A }, "k1");
    const token = signPlaybackToken(r, input);
    expect(() => verifyPlaybackToken(ring({ other: SECRET_A }, "other"), token)).toThrow(/Invalid/);
    const tampered = `${token.slice(0, -2)}${token.endsWith("A") ? "BB" : "AA"}`;
    expect(() => verifyPlaybackToken(r, tampered)).toThrow(/Invalid/);
    const wrongAud = jwt.sign({ vid: "vid-1" }, SECRET_A, {
      algorithm: "HS256",
      keyid: "k1",
      subject: "v",
      jwtid: "j",
      issuer: "evs",
      audience: "something-else",
    });
    expect(() => verifyPlaybackToken(r, wrongAud)).toThrow(/Invalid/);
  });

  it("rejects alg=none and expired tokens", () => {
    const r = ring({ k1: SECRET_A }, "k1");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ vid: "vid-1", sub: "v", jti: "j", iss: "evs", aud: PLAYBACK_AUDIENCE })
    ).toString("base64url")}.`;
    expect(() => verifyPlaybackToken(r, none)).toThrow(/Invalid/);
    const expired = jwt.sign({ vid: "vid-1", exp: Math.floor(Date.now() / 1000) - 10 }, SECRET_A, {
      algorithm: "HS256",
      keyid: "k1",
      subject: "v",
      jwtid: "j",
      issuer: "evs",
      audience: PLAYBACK_AUDIENCE,
    });
    expect(() => verifyPlaybackToken(r, expired)).toThrow(/expired/);
  });

  it("refuses to sign when the active kid is missing from the ring", () => {
    expect(() => signPlaybackToken(ring({ k1: SECRET_A }, "k9"), input)).toThrow(/not in the keyring/);
  });
});
