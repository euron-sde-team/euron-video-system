import { execFileSync, spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HLS_KEY_URI_PLACEHOLDER } from "@evs/core/constants";
import { contentKeys } from "@evs/core/crypto";
import { transcode } from "../../src/encoding/ffmpeg.js";
import { packageHlsAes } from "../../src/encoding/hls.js";
import { selectLadder } from "../../src/encoding/ladder.js";
import { probe, type ProbeResult } from "../../src/encoding/probe.js";
import { generateThumbnails } from "../../src/encoding/thumbnails.js";

/**
 * Runs the REAL encoding pipeline (ffprobe + ffmpeg) on a synthetic 4s clip:
 * probe -> ladder -> single-decode transcode -> AES-128 HLS packaging ->
 * thumbnails, then proves the segments are actually encrypted with the key and
 * IV the playlist advertises. Storage and the database are out of scope here.
 */
const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
// eslint-disable-next-line no-console -- surfaced on purpose so a CI skip is visible
if (!hasFfmpeg) console.warn("[pipeline.int] ffmpeg/ffprobe not on PATH: skipping the real-encode test");

describe.skipIf(!hasFfmpeg)("encoding pipeline (real ffmpeg)", () => {
  let dir: string;
  let source: string;
  let probed: ProbeResult;
  const key = contentKeys.generate();
  const outputDir = () => path.join(dir, "output");

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "evs-pipeline-"));
    source = path.join(dir, "source.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);

    probed = await probe(source);
    const ladder = selectLadder(probed.orientation, probed.width, probed.height, probed.bitrateKbps);
    const renditions = path.join(dir, "renditions");
    await mkdir(renditions);
    await mkdir(outputDir());
    const { videoFiles, audioFile } = await transcode(source, renditions, ladder, probed.hasAudio, probed.rotation, probed.durationSec, probed.fps);
    await packageHlsAes({
      outputDir: outputDir(),
      videoFiles,
      audioFile,
      key: { keyBytes: key.keyBytes },
      keyUriPlaceholder: HLS_KEY_URI_PLACEHOLDER,
      workDir: renditions,
      captions: null,
      durationSec: probed.durationSec,
    });
    await generateThumbnails(source, outputDir(), probed.width, probed.height, probed.durationSec);
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("probes the synthetic source", () => {
    expect(probed).toMatchObject({ width: 640, height: 360, orientation: "landscape", hasAudio: true, rotation: 0 });
    expect(probed.durationSec).toBe(4);
  });

  it("writes a master listing only the rungs that do not upscale", async () => {
    const master = await readFile(path.join(outputDir(), "hls/master.m3u8"), "utf8");
    // 360p source: only the floor rung (480) survives; a tiny source always keeps one playable rendition.
    expect(master).toContain("480/index.m3u8");
    expect(master).not.toContain("720/index.m3u8");
    expect(master).toContain('CODECS="avc1.640028,mp4a.40.2"');
  });

  it("encrypts every segment with AES-128 and the key placeholder, and decrypts with the advertised IV", async () => {
    const variantDir = path.join(outputDir(), "hls/480");
    const playlist = await readFile(path.join(variantDir, "index.m3u8"), "utf8");
    const keyLine = playlist.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    expect(keyLine).toContain("METHOD=AES-128");
    expect(keyLine).toContain(`URI="${HLS_KEY_URI_PLACEHOLDER}"`);

    const segments = playlist.split("\n").filter((l) => l.endsWith(".ts"));
    expect(segments.length).toBeGreaterThan(0);
    const first = await readFile(path.join(variantDir, segments[0] as string));
    // A clear MPEG-TS packet starts with the 0x47 sync byte; ciphertext must not.
    expect(first[0]).not.toBe(0x47);

    // HLS spec: explicit IV attribute, else the media sequence number as a 128-bit big-endian int.
    const ivAttr = keyLine?.match(/IV=0x([0-9a-fA-F]{32})/)?.[1];
    const seq = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0);
    const iv = Buffer.alloc(16);
    if (ivAttr) Buffer.from(ivAttr, "hex").copy(iv);
    else iv.writeUInt32BE(seq, 12);

    const decrypt = (data: Buffer, withIv: Buffer): Buffer => {
      const d = createDecipheriv("aes-128-cbc", key.keyBytes, withIv);
      return Buffer.concat([d.update(data), d.final()]); // final() also validates PKCS#7 padding
    };

    // Every segment decrypts with the ADVERTISED IV into well-formed MPEG-TS:
    // a whole number of 188-byte packets, each starting with the 0x47 sync byte.
    for (const seg of segments) {
      const clear = decrypt(await readFile(path.join(variantDir, seg)), iv);
      expect(clear.length % 188).toBe(0);
      for (let off = 0; off < clear.length; off += 188) expect(clear[off]).toBe(0x47);
    }

    // The first packet is the SDT table (PID 0x11), whose byte 15 is a reserved
    // field that must be 0xff. CBC's IV only affects the first 16-byte block, so
    // this is what proves the advertised IV (not merely the key) is the one used.
    const firstClear = decrypt(first, iv);
    expect(firstClear.readUInt16BE(1) & 0x1fff).toBe(0x11);
    expect(firstClear[15]).toBe(0xff);
    const wrongIv = Buffer.from(iv);
    wrongIv[15] = (wrongIv[15] ?? 0) ^ 0x01;
    expect(decrypt(first, wrongIv)[15]).not.toBe(0xff);
  });

  it("never ships the raw key into the output tree", async () => {
    const files = (await readdir(outputDir(), { recursive: true })).map(String);
    expect(files.some((f) => f.endsWith(".key") || f.endsWith(".keyinfo"))).toBe(false);
  });

  it("produces a poster and a sprite thumbnail track", async () => {
    expect((await stat(path.join(outputDir(), "poster.jpg"))).size).toBeGreaterThan(0);
    const vtt = await readFile(path.join(outputDir(), "thumbnails/thumbnails.vtt"), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("sprite_001.jpg#xywh=");
    expect((await stat(path.join(outputDir(), "thumbnails/sprite_001.jpg"))).size).toBeGreaterThan(0);
  });
});
