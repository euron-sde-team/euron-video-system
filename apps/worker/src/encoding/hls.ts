import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import { run } from "./exec.js";
import type { Rung } from "./ladder.js";

export interface HlsAesInput {
  /** The packaged tree lands under `outputDir/hls/`. */
  outputDir: string;
  /** Per-rung intermediate MP4s already produced by transcode() (H.264 high, no audio). */
  videoFiles: { rung: Rung; file: string }[];
  /** Shared AAC audio file, or null when the source had no audio. */
  audioFile: string | null;
  /** Raw 16-byte AES-128 content key. */
  key: { keyBytes: Buffer };
  /**
   * Tokenless sentinel baked into the EXT-X-KEY URI at transcode time. Per-viewer
   * playback tokens cannot be known here, so the API rewrites this placeholder to
   * the authorized key URL (with `?token=`) per request before serving the playlist.
   */
  keyUriPlaceholder: string;
  /** Per-job temp dir for the key + key-info files. NEVER under outputDir (never shipped). */
  workDir: string;
  /** Captions to expose as an HLS subtitle rendition, or null. */
  captions: { vttFile: string; lang: string } | null;
  /** Content duration (s); the subtitle media playlist needs an EXTINF. */
  durationSec: number;
  /** Cancellation: kills the per-rung remux if the worker loses ownership. */
  signal?: AbortSignal;
}

export interface HlsAesResult {
  /** Relative path of the master playlist under outputDir. */
  master: string;
}

/** Directory (relative to the video's output prefix) holding the HLS tree. */
export const HLS_DIR = "hls";

const SUBS_GROUP = "subs";

const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  hi: "Hindi",
  pt: "Portuguese",
  ja: "Japanese",
};

/** H.264 High @4.0 + AAC-LC. Players are lenient about the exact level digits. */
export const VIDEO_CODEC = "avc1.640028";
export const AUDIO_CODEC = "mp4a.40.2";

/**
 * Insert an `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000` line into the WebVTT
 * header block (right after the `WEBVTT` magic) so native Safari aligns cues
 * with the MPEG-TS media timeline (which we force to start at PTS 0).
 */
export const withTimestampMap = (vtt: string): string => {
  const normalized = vtt.replace(/\r\n/g, "\n");
  const nl = normalized.indexOf("\n");
  const head = nl === -1 ? normalized : normalized.slice(0, nl); // "WEBVTT..."
  const rest = nl === -1 ? "" : normalized.slice(nl + 1);
  return `${head}\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n${rest}`;
};

/**
 * Write the subtitle rendition (subs/<lang>.vtt + subs/<lang>.m3u8) under an
 * HLS root. Shared so BOTH the PRIMARY packaging AND the decoupled CAPTIONS job
 * (which re-uploads just these + master.m3u8 after whisper finishes) produce the
 * identical layout the player expects.
 */
export const writeSubtitleRendition = async (
  hlsRoot: string,
  vttFile: string,
  lang: string,
  durationSec: number
): Promise<void> => {
  const subsDir = path.join(hlsRoot, "subs");
  await mkdir(subsDir, { recursive: true });

  // Prepend X-TIMESTAMP-MAP so cues map to the (PTS-0) TS media timeline.
  const rawVtt = await readFile(vttFile, "utf8");
  await writeFile(path.join(subsDir, `${lang}.vtt`), withTimestampMap(rawVtt));

  // Single full-duration WebVTT "segment" VOD subtitle playlist.
  const dur = Math.max(1, durationSec);
  const subPlaylist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${dur}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${dur}.000,`,
    `${lang}.vtt`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  await writeFile(path.join(subsDir, `${lang}.m3u8`), subPlaylist);
};

/**
 * Synthesize the master playlist for a rung set, optionally exposing a subtitle
 * rendition (captionLang != null). Deterministic in (rungs, hasAudio,
 * captionLang), so the CAPTIONS job rebuilds a master byte-identical to the
 * PRIMARY's plus the subtitle lines, given the same (deterministic) ladder.
 */
export const buildMasterPlaylist = (
  videoFiles: { rung: Rung }[],
  hasAudio: boolean,
  captionLang: string | null
): string => {
  const audioBps = hasAudio ? 128_000 : 0;
  const codecs = hasAudio ? `${VIDEO_CODEC},${AUDIO_CODEC}` : VIDEO_CODEC;

  let subtitleMedia = "";
  let subtitlesAttr = "";
  if (captionLang) {
    const name = LANG_NAMES[captionLang] ?? captionLang.toUpperCase();
    subtitleMedia =
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBS_GROUP}",NAME="${name}",` +
      `LANGUAGE="${captionLang}",DEFAULT=YES,AUTOSELECT=YES,URI="subs/${captionLang}.m3u8"`;
    subtitlesAttr = `,SUBTITLES="${SUBS_GROUP}"`;
  }

  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  if (subtitleMedia) lines.push(subtitleMedia);
  for (const { rung } of videoFiles) {
    const bandwidth = rung.maxrateKbps * 1000 + audioBps;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},` +
        `RESOLUTION=${rung.width}x${rung.height},CODECS="${codecs}"${subtitlesAttr}`
    );
    lines.push(`${rung.name}/index.m3u8`);
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * Build the AES-128 (METHOD=AES-128) HLS-over-MPEG-TS tree. One tree serves
 * every client: hls.js plays it through MSE on Chrome/Firefox/Edge/Android, and
 * Safari/iOS play it natively. No CDM is involved; the key is fetched over HTTPS
 * from the tokenized key endpoint.
 *
 * Cheap: it REMUXES (`-c copy`) the per-rung MP4s the transcoder already
 * produced into TS + AES-128, never re-encoding. Keyframes are already
 * 4s-aligned, so 4s segmenting cuts cleanly and rungs stay switchable.
 *
 * The raw key + key-info files live only under `workDir` (the temp renditions
 * dir), never under `outputDir`, so the upload step (which walks outputDir)
 * cannot leak the content key to object storage.
 */
export const packageHlsAes = async (input: HlsAesInput): Promise<HlsAesResult> => {
  const ffmpeg = getWorkerConfig().FFMPEG_BIN;
  const root = path.join(input.outputDir, HLS_DIR);
  await mkdir(root, { recursive: true });

  // ── shared key + key-info file (one key for all rungs) ──────────────────────
  const keyPath = path.join(input.workDir, "enc.key");
  await writeFile(keyPath, input.key.keyBytes, { mode: 0o600 });
  // Line 1: URI written verbatim into EXT-X-KEY (rewritten per request by the API).
  // Line 2: path ffmpeg READS the 16 raw key bytes from to encrypt.
  // (No line 3: ffmpeg then uses an all-zero IV for every segment and DECLARES
  //  it explicitly as IV=0x0... on the EXT-X-KEY line, so players never fall
  //  back to the sequence-number IV rule. The key is unique per video, so the
  //  IV is never reused across keys. See docs/architecture/security.md.)
  const keyInfoPath = path.join(input.workDir, "hls.keyinfo");
  await writeFile(keyInfoPath, `${input.keyUriPlaceholder}\n${keyPath}\n`, { mode: 0o600 });

  for (const { rung, file } of input.videoFiles) {
    const rungDir = path.join(root, rung.name);
    await mkdir(rungDir, { recursive: true });
    const args = ["-y", "-i", file];
    if (input.audioFile) args.push("-i", input.audioFile);
    args.push("-map", "0:v:0");
    if (input.audioFile) args.push("-map", "1:a:0");
    args.push("-c:v", "copy");
    if (input.audioFile) args.push("-c:a", "copy");
    args.push(
      // Start the TS timeline at PTS 0 so the WebVTT X-TIMESTAMP-MAP:MPEGTS:0
      // aligns captions with the media on native Safari.
      "-muxpreload", "0",
      "-muxdelay", "0",
      "-f", "hls",
      "-hls_time", "4",
      "-hls_playlist_type", "vod",
      "-hls_segment_type", "mpegts",
      "-hls_flags", "temp_file",
      "-hls_key_info_file", keyInfoPath,
      "-hls_segment_filename", path.join(rungDir, "seg_%03d.ts"),
      path.join(rungDir, "index.m3u8")
    );
    // The TS muxer auto-applies h264_mp4toannexb + AAC ADTS framing; no manual -bsf.
    await run(ffmpeg, args, `hls-${rung.name}`, { signal: input.signal });
  }

  if (input.captions) {
    await writeSubtitleRendition(root, input.captions.vttFile, input.captions.lang, input.durationSec);
  }

  // ffmpeg's per-rung runs don't write a master; synthesize it.
  const master = buildMasterPlaylist(input.videoFiles, !!input.audioFile, input.captions?.lang ?? null);
  await writeFile(path.join(root, "master.m3u8"), master);

  return { master: `${HLS_DIR}/master.m3u8` };
};
