import { describe, expect, it } from "vitest";
import { parseThumbnailVtt, thumbAtTime } from "../src/hooks/useVttThumbnails";

const VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
sprite_000.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite_000.jpg#xywh=160,0,160,90

01:00:10.000 --> 01:00:15.500
sprite_001.jpg#xywh=0,90,160,90
`;

const BASE = "https://cdn.example.test/media/01ABC/thumbnails/thumbnails.vtt?sig=abc";

describe("parseThumbnailVtt", () => {
  it("parses each cue's time range and #xywh sprite geometry", () => {
    const tiles = parseThumbnailVtt(VTT, BASE);
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toMatchObject({ startTime: 0, duration: 5, x: 0, y: 0, width: 160, height: 90 });
    expect(tiles[1]).toMatchObject({ startTime: 5, x: 160, y: 0 });
  });

  it("handles HH:MM:SS timestamps", () => {
    const tiles = parseThumbnailVtt(VTT, BASE);
    expect(tiles[2]).toMatchObject({ startTime: 3610, duration: 5.5, y: 90 });
  });

  it("resolves relative sprite paths against the VTT URL and drops the fragment", () => {
    const tiles = parseThumbnailVtt(VTT, BASE);
    expect(tiles[0]?.sheetUrl).toBe("https://cdn.example.test/media/01ABC/thumbnails/sprite_000.jpg");
    expect(tiles[2]?.sheetUrl).toBe("https://cdn.example.test/media/01ABC/thumbnails/sprite_001.jpg");
  });

  it("keeps absolute (signed) sprite URLs written in by the API intact", () => {
    const vtt = `WEBVTT\n\n00:00.000 --> 00:05.000\nhttps://signed.example.test/s0.jpg?X-Amz-Signature=deadbeef#xywh=0,0,10,10\n`;
    const [tile] = parseThumbnailVtt(vtt, BASE);
    expect(tile?.sheetUrl).toBe("https://signed.example.test/s0.jpg?X-Amz-Signature=deadbeef");
    expect(tile).toMatchObject({ startTime: 0, duration: 5, width: 10 });
  });

  it("skips cues with malformed timing or geometry, and normalizes CRLF", () => {
    const vtt = [
      "WEBVTT",
      "",
      "bad --> 00:00:05.000",
      "s.jpg#xywh=0,0,1,1",
      "",
      "00:00:05.000 --> 00:00:10.000",
      "s.jpg#xywh=0,zero,1,1",
      "",
      "00:00:10.000 --> 00:00:15.000",
      "s.jpg",
      "",
      "00:00:15.000 --> 00:00:20.000",
      "s.jpg#xywh=4,5,6,7",
    ].join("\r\n");
    const tiles = parseThumbnailVtt(vtt, BASE);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ startTime: 15, x: 4, y: 5, width: 6, height: 7 });
  });
});

describe("thumbAtTime", () => {
  const tiles = parseThumbnailVtt(VTT, BASE);

  it("returns the tile covering a time (start inclusive, end exclusive)", () => {
    expect(thumbAtTime(tiles, 0)?.x).toBe(0);
    expect(thumbAtTime(tiles, 4.99)?.x).toBe(0);
    expect(thumbAtTime(tiles, 5)?.x).toBe(160);
  });

  it("clamps past the last cue and handles an empty list", () => {
    expect(thumbAtTime(tiles, 99_999)?.startTime).toBe(3610);
    expect(thumbAtTime([], 3)).toBeNull();
  });
});
