import { describe, expect, it } from "vitest";
import {
  collectMediaRenditionUris,
  collectSegmentUris,
  collectSpriteUris,
  isSafeRelativePath,
  rewriteMaster,
  rewriteThumbnailsVtt,
  rewriteVariant,
} from "../src/playback/manifest-rewrite.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="subs"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,SUBTITLES="subs"
720/index.m3u8
`;

const VARIANT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="EVS_KEY_URI",IV=0x00000000000000000000000000000000
#EXTINF:4.000,
seg_00000.ts
#EXTINF:4.000,
seg_00001.ts
#EXT-X-ENDLIST
`;

describe("master playlist rewrite", () => {
  it("tokenizes variant URIs and signs subtitle renditions, leaving tags intact", () => {
    expect(collectMediaRenditionUris(MASTER)).toEqual(["subs/en.m3u8"]);
    const out = rewriteMaster(MASTER, {
      variantUrl: (u) => `https://api/v1/play/v/${u}?token=T`,
      renditionUrl: (u) => `https://cdn/${u}?sig=1`,
    });
    expect(out).toContain("https://api/v1/play/v/1080/index.m3u8?token=T");
    expect(out).toContain("https://api/v1/play/v/720/index.m3u8?token=T");
    expect(out).toContain('URI="https://cdn/subs/en.m3u8?sig=1"');
    expect(out).toContain("#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080");
    expect(out.split("\n")).toHaveLength(MASTER.split("\n").length);
  });
});

describe("variant playlist rewrite", () => {
  it("injects the tokenized key URL and signs every segment", () => {
    expect(collectSegmentUris(VARIANT)).toEqual(["seg_00000.ts", "seg_00001.ts"]);
    const out = rewriteVariant(VARIANT, {
      keyUrl: "https://api/v1/play/v/key?token=T",
      segmentUrl: (s) => `https://cdn/${s}?sig=1`,
    });
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="https://api/v1/play/v/key?token=T",IV=0x');
    expect(out).not.toContain("EVS_KEY_URI");
    expect(out).toContain("https://cdn/seg_00000.ts?sig=1");
    expect(out).toContain("https://cdn/seg_00001.ts?sig=1");
    expect(out).toContain("#EXT-X-ENDLIST");
  });
});

describe("thumbnail VTT rewrite", () => {
  const VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
sprite_000.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite_000.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
sprite_001.jpg#xywh=0,0,160,90
`;
  it("signs each distinct sprite once and keeps the media fragment", () => {
    expect(collectSpriteUris(VTT)).toEqual(["sprite_000.jpg", "sprite_001.jpg"]);
    const out = rewriteThumbnailsVtt(VTT, (s) => `https://cdn/thumbnails/${s}?sig=1`);
    expect(out).toContain("https://cdn/thumbnails/sprite_000.jpg?sig=1#xywh=160,0,160,90");
    expect(out).toContain("https://cdn/thumbnails/sprite_001.jpg?sig=1#xywh=0,0,160,90");
    expect(out).toContain("00:00:05.000 --> 00:00:10.000");
  });
});

describe("path safety", () => {
  it.each(["hls/720/seg_00001.ts", "thumbnails/sprite_000.jpg", "poster.jpg"])("accepts %s", (p) => {
    expect(isSafeRelativePath(p)).toBe(true);
  });
  it.each(["../secret", "hls/../../x", "/etc/passwd", "hls//x", "hls\\x", "a?b", "a#b", "", "hls/./x", "a b"])(
    "rejects %j",
    (p) => {
      expect(isSafeRelativePath(p)).toBe(false);
    }
  );
});
