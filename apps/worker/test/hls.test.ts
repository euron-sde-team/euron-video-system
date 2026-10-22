import { describe, expect, it } from "vitest";
import { AUDIO_CODEC, buildMasterPlaylist, VIDEO_CODEC, withTimestampMap } from "../src/encoding/hls.js";
import { LANDSCAPE } from "../src/encoding/ladder.js";

const files = LANDSCAPE.map((rung) => ({ rung }));

describe("buildMasterPlaylist", () => {
  it("lists one variant per rung with bandwidth from maxrate + audio", () => {
    const m = buildMasterPlaylist(files, true, null);
    const lines = m.trim().split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines).toContain("1080/index.m3u8");
    expect(lines).toContain("720/index.m3u8");
    expect(lines).toContain("480/index.m3u8");
    expect(m).toContain(`BANDWIDTH=${5350 * 1000 + 128_000},RESOLUTION=1920x1080,CODECS="${VIDEO_CODEC},${AUDIO_CODEC}"`);
    expect(m).not.toContain("SUBTITLES");
  });

  it("omits the audio codec and bitrate for a silent source", () => {
    const m = buildMasterPlaylist(files, false, null);
    expect(m).toContain(`BANDWIDTH=${5350 * 1000},RESOLUTION=1920x1080,CODECS="${VIDEO_CODEC}"`);
    expect(m).not.toContain(AUDIO_CODEC);
  });

  it("adds a subtitle rendition and references it from every variant", () => {
    const m = buildMasterPlaylist(files, true, "en");
    expect(m).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en"');
    expect(m).toContain('URI="subs/en.m3u8"');
    expect(m.match(/SUBTITLES="subs"/g)).toHaveLength(3);
  });

  it("is deterministic (the captions job rebuilds an identical master)", () => {
    expect(buildMasterPlaylist(files, true, "en")).toBe(buildMasterPlaylist(files, true, "en"));
  });
});

describe("withTimestampMap", () => {
  it("inserts X-TIMESTAMP-MAP right after the WEBVTT header", () => {
    const out = withTimestampMap("WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nhi\r\n");
    expect(out.split("\n").slice(0, 2)).toEqual(["WEBVTT", "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000"]);
    expect(out).not.toContain("\r");
  });
});
