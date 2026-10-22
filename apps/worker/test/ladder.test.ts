import { describe, expect, it } from "vitest";
import { LANDSCAPE, MIN_TRUSTED_SOURCE_KBPS, selectLadder, VERTICAL } from "../src/encoding/ladder.js";

const capOn = { enabled: true, factor: 1.1, floor: 0.6 };
const capOff = { enabled: false, factor: 1.1, floor: 0.6 };
const names = (r: { name: string }[]) => r.map((x) => x.name);

describe("selectLadder", () => {
  it("uses the full landscape ladder for a 1080p source", () => {
    expect(names(selectLadder("landscape", 1920, 1080, 0, capOff))).toEqual(["1080", "720", "480"]);
  });

  it("never upscales: a 720p source drops the 1080 rung", () => {
    expect(names(selectLadder("landscape", 1280, 720, 0, capOff))).toEqual(["720", "480"]);
  });

  it("keeps the floor rung for a tiny source", () => {
    const rungs = selectLadder("landscape", 320, 180, 0, capOff);
    expect(names(rungs)).toEqual(["480"]);
    expect(rungs[0]).toEqual(LANDSCAPE[2]);
  });

  it("uses the vertical ladder keyed on width for portrait sources", () => {
    expect(names(selectLadder("portrait", 1080, 1920, 0, capOff))).toEqual(["1080", "720", "540"]);
    expect(names(selectLadder("portrait", 720, 1280, 0, capOff))).toEqual(["720", "540"]);
    expect(selectLadder("portrait", 400, 700, 0, capOff)[0]).toEqual(VERTICAL[2]);
  });

  it("treats square sources as landscape", () => {
    expect(names(selectLadder("square", 1080, 1080, 0, capOff))).toEqual(["1080", "720", "480"]);
  });

  it("caps rung bitrate to source x factor, but never below the floor", () => {
    // source 2000 kbps -> cap 2200. 1080 (5000): floor 3000 wins. 720 (3000): floor 1800 < cap -> 2200. 480 (1400): untouched.
    const [r1080, r720, r480] = selectLadder("landscape", 1920, 1080, 2000, capOn);
    expect(r1080?.videoKbps).toBe(3000);
    expect(r1080?.maxrateKbps).toBe(Math.round(3000 * 1.07));
    expect(r1080?.bufsizeKbps).toBe(4500);
    expect(r720?.videoKbps).toBe(2200);
    expect(r480).toEqual(LANDSCAPE[2]);
  });

  it("never raises a rung above its ladder target", () => {
    const rungs = selectLadder("landscape", 1920, 1080, 50_000, capOn);
    expect(rungs).toEqual(LANDSCAPE);
  });

  it("ignores an untrusted (near-zero) source bitrate", () => {
    expect(selectLadder("landscape", 1920, 1080, MIN_TRUSTED_SOURCE_KBPS - 1, capOn)).toEqual(LANDSCAPE);
    expect(selectLadder("landscape", 1920, 1080, 0, capOn)).toEqual(LANDSCAPE);
  });

  it("is a no-op when the cap is disabled", () => {
    expect(selectLadder("landscape", 1920, 1080, 2000, capOff)).toEqual(LANDSCAPE);
  });
});
