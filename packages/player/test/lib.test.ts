import { describe, expect, it } from "vitest";
import { buildQualityOptions, shouldUseNativeHls } from "../src/lib";
import { formatTime } from "../src/format";

describe("buildQualityOptions", () => {
  const levels = [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720, bitrate: 2_800_000 },
    { height: 720, bitrate: 3_200_000 }, // same height, higher bitrate: wins
    { height: 480, bitrate: 1_400_000 },
    { height: 0, bitrate: 128_000 }, // audio-only level: ignored
  ];

  it("dedupes by height, keeps the highest bitrate, sorts high to low", () => {
    const q = buildQualityOptions(levels, -1);
    expect(q.map((o) => o.label)).toEqual(["1080p", "720p", "480p"]);
    expect(q.find((o) => o.height === 720)?.levelIndex).toBe(2);
  });

  it("marks no option active while ABR has not picked a level", () => {
    expect(buildQualityOptions(levels, -1).some((o) => o.active)).toBe(false);
  });

  it("marks the option matching the current level's height active", () => {
    // Level 1 is the lower-bitrate 720p; the deduped 720p option is still active.
    const q = buildQualityOptions(levels, 1);
    expect(q.filter((o) => o.active).map((o) => o.height)).toEqual([720]);
  });

  it("tolerates an out-of-range current level and empty input", () => {
    expect(buildQualityOptions(levels, 42).some((o) => o.active)).toBe(false);
    expect(buildQualityOptions([], 0)).toEqual([]);
  });
});

describe("shouldUseNativeHls", () => {
  const supportsHls = (m: string) => (m === "application/vnd.apple.mpegurl" ? "maybe" : "");
  const noHls = () => "";

  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPHONE_CHROME =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
  const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

  it("uses native HLS on iPhone (any WebKit browser) when HLS is playable", () => {
    expect(shouldUseNativeHls(IPHONE_SAFARI, supportsHls)).toBe(true);
    expect(shouldUseNativeHls(IPHONE_CHROME, supportsHls)).toBe(true);
  });

  it("uses hls.js on desktop Safari and iPadOS even though they can play HLS natively", () => {
    expect(shouldUseNativeHls(MAC_SAFARI, supportsHls)).toBe(false);
  });

  it("uses hls.js on Android and when the device reports no HLS support", () => {
    expect(shouldUseNativeHls(ANDROID_CHROME, supportsHls)).toBe(false);
    expect(shouldUseNativeHls(IPHONE_SAFARI, noHls)).toBe(false);
  });
});

describe("formatTime", () => {
  it("formats m:ss under an hour and h:mm:ss above", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  it("clamps invalid input to zero", () => {
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(-4)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
