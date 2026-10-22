import { describe, expect, it } from "vitest";
import { buildThumbnailsVtt, thumbHeight, vttTime } from "../src/encoding/thumbnails.js";

describe("thumbnails", () => {
  it("formats VTT timestamps", () => {
    expect(vttTime(0)).toBe("00:00:00.000");
    expect(vttTime(3661.5)).toBe("01:01:01.500");
  });

  it("keeps tile height even and proportional", () => {
    expect(thumbHeight(1920, 1080)).toBe(90);
    expect(thumbHeight(1080, 1920)).toBe(284);
    expect(thumbHeight(1000, 333)).toBe(54); // 53.28 -> 53 -> even 54
  });

  it("maps every 5s interval to a sprite tile, rolling to the next sheet after 100", () => {
    const vtt = buildThumbnailsVtt(505, 1920, 1080);
    const cues = vtt.split("\n").filter((l) => l.includes("#xywh="));
    expect(cues).toHaveLength(101);
    expect(cues[0]).toBe("sprite_001.jpg#xywh=0,0,160,90");
    expect(cues[11]).toBe("sprite_001.jpg#xywh=160,90,160,90");
    expect(cues[100]).toBe("sprite_002.jpg#xywh=0,0,160,90");
    expect(vtt).toContain("00:08:20.000 --> 00:08:25.000");
  });

  it("produces at least one cue for a zero-length source", () => {
    expect(buildThumbnailsVtt(0, 640, 360).match(/#xywh=/g)).toHaveLength(1);
  });
});
