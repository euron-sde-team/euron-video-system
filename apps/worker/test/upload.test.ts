import { describe, expect, it } from "vitest";
import { OwnershipLostError } from "../src/encoding/exec.js";
import { cacheControlFor, contentTypeFor, withRetry } from "../src/upload.js";

describe("upload helpers", () => {
  it("assigns content types and cache policy by file", () => {
    expect(contentTypeFor("hls/720/index.m3u8")).toBe("application/vnd.apple.mpegurl");
    expect(contentTypeFor("hls/720/seg_000.ts")).toBe("video/mp2t");
    expect(contentTypeFor("thumbnails/thumbnails.vtt")).toBe("text/vtt");
    expect(contentTypeFor("poster.jpg")).toBe("image/jpeg");
    expect(cacheControlFor("hls/master.m3u8")).toContain("max-age=300");
    expect(cacheControlFor("hls/720/seg_000.ts")).toContain("immutable");
  });

  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      if (++calls < 3) throw new Error("503 SlowDown");
      return "ok";
    }, "t", undefined, 5, 1);
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("never retries a lost claim", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new OwnershipLostError("t");
      }, "t", undefined, 5, 1)
    ).rejects.toBeInstanceOf(OwnershipLostError);
    expect(calls).toBe(1);
  });

  it("stops immediately on an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(withRetry(async () => "x", "t", ac.signal)).rejects.toBeInstanceOf(OwnershipLostError);
  });
});
