import { describe, expect, it } from "vitest";
import { scrub, toPublicError } from "../src/public-error.js";

// The exact error a truncated upload produced in a real end-to-end run.
const REAL_FFPROBE_FAILURE =
  "[ffprobe] exited 1: [mov,mp4,m4a,3gp,3g2,mj2 @ 0xffff9c4d9ac0] moov atom not found\n" +
  "/work/01M5HKKPYM65N6VJA7WMCFF3CH/src/original.mp4: Invalid data found when processing input";

describe("toPublicError", () => {
  it("turns a corrupt-source ffprobe failure into one clear sentence", () => {
    const msg = toPublicError(new Error(REAL_FFPROBE_FAILURE));
    expect(msg).toMatch(/not a readable video/);
    expect(msg).not.toMatch(/\/work\//);
    expect(msg).not.toMatch(/0x[0-9a-f]+/i);
  });

  it("recognizes missing sources, full disks and killed encoders", () => {
    expect(toPublicError(new Error("NoSuchKey: The specified key does not exist."))).toMatch(/missing from storage/);
    expect(toPublicError(new Error("write failed: ENOSPC"))).toMatch(/scratch disk/);
    expect(toPublicError(new Error("[ffmpeg] killed by SIGKILL"))).toMatch(/interrupted/);
  });

  it("scrubs and truncates anything unrecognized", () => {
    const msg = toPublicError(new Error(`unexpected thing at /var/lib/evs/work/a/b.ts ptr 0xdeadbeef00 ${"x".repeat(500)}`));
    expect(msg).toContain("<path>");
    expect(msg).toContain("<addr>");
    expect(msg.length).toBeLessThanOrEqual(300);
  });

  it("never returns an empty message", () => {
    expect(toPublicError(new Error(""))).toBe("Transcoding failed.");
    expect(toPublicError("plain string")).toBe("plain string");
  });
});

describe("scrub", () => {
  it("removes ANSI colour codes and collapses whitespace", () => {
    expect(scrub("\u001b[31mred\u001b[0m\n\n  text")).toBe("red text");
  });

  it("leaves short relative tokens alone", () => {
    expect(scrub("rung 720/index.m3u8 failed")).toBe("rung 720/index.m3u8 failed");
  });
});
