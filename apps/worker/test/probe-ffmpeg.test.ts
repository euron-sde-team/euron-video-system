import { describe, expect, it } from "vitest";
import { buildFilterComplex, isNearStatic, rotationFilter } from "../src/encoding/ffmpeg.js";
import { LANDSCAPE } from "../src/encoding/ladder.js";
import { displayRotation, interpretProbe, parseFrameRate } from "../src/encoding/probe.js";

describe("probe interpretation", () => {
  it("parses rational frame rates and rejects degenerate ones", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("25")).toBe(25);
    expect(parseFrameRate("0/0")).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
  });

  it("derives clockwise rotation from the display matrix or the legacy tag", () => {
    expect(displayRotation({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })).toBe(90);
    expect(displayRotation({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] })).toBe(270);
    expect(displayRotation({ tags: { rotate: "180" } })).toBe(180);
    expect(displayRotation({ tags: { rotate: "45" } })).toBe(0);
  });

  it("swaps display dimensions for a 90-degree phone video", () => {
    const r = interpretProbe({
      streams: [
        { codec_type: "video", width: 1920, height: 1080, bit_rate: "4000000", avg_frame_rate: "30/1", tags: { rotate: "90" } },
        { codec_type: "audio" },
      ],
      format: { duration: "12.4" },
    });
    expect(r).toMatchObject({ width: 1080, height: 1920, orientation: "portrait", rotation: 90, hasAudio: true, bitrateKbps: 4000, fps: 30, durationSec: 12 });
  });

  it("falls back to the container bitrate and fails without a video stream", () => {
    expect(interpretProbe({ streams: [{ codec_type: "video", width: 640, height: 640 }], format: { bit_rate: "900000" } })).toMatchObject({ orientation: "square", bitrateKbps: 900, hasAudio: false });
    expect(() => interpretProbe({ streams: [{ codec_type: "audio" }] })).toThrow(/no video stream/);
  });
});

describe("ffmpeg graph", () => {
  it("decodes once and splits into one scale chain per rung", () => {
    expect(buildFilterComplex(LANDSCAPE, 0)).toBe(
      "[0:v]split=3[s0][s1][s2];[s0]scale=-2:1080:flags=lanczos[v0];[s1]scale=-2:720:flags=lanczos[v1];[s2]scale=-2:480:flags=lanczos[v2]"
    );
  });

  it("rotates before the split", () => {
    expect(buildFilterComplex(LANDSCAPE.slice(0, 1), 90)).toBe("[0:v]transpose=1,split=1[s0];[s0]scale=-2:1080:flags=lanczos[v0]");
    expect(rotationFilter(180)).toBe("transpose=1,transpose=1");
    expect(rotationFilter(0)).toBeNull();
  });

  it("flags near-static sources", () => {
    expect(isNearStatic(0)).toBe(true);
    expect(isNearStatic(0.14)).toBe(true);
    expect(isNearStatic(15)).toBe(false);
    expect(isNearStatic(23.976)).toBe(false);
  });
});
