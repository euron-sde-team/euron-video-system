import { HLS_KEY_URI_PLACEHOLDER } from "@evs/core/constants";

/**
 * Per-request HLS playlist rewriting.
 *
 * Native HLS (Safari, iOS) fetches the key URI, variant playlists and segments
 * itself, with no way to attach an Authorization header. The per-viewer
 * playback token must therefore ride inside the URLs, so the stored playlists
 * are rewritten on every request:
 *
 *   master   variant URI  -> tokenized API URL for that variant playlist
 *            EXT-X-MEDIA subtitle URI -> signed delivery URL
 *   variant  EXT-X-KEY sentinel -> tokenized key URL
 *            segment URI -> signed delivery URL (CDN, presigned or proxied)
 *
 * These are pure functions over strings so they are exhaustively unit-tested;
 * the controller only fetches the stored playlist and supplies URL builders.
 */

/** Any URI line: not blank, not a tag/comment. */
const isUriLine = (trimmed: string): boolean => trimmed.length > 0 && !trimmed.startsWith("#");

/** Collect every relative URI a playlist references (segments, or subtitle renditions). */
export const collectSegmentUris = (playlist: string): string[] =>
  playlist
    .split("\n")
    .map((l) => l.trim())
    .filter(isUriLine);

export const collectMediaRenditionUris = (master: string): string[] =>
  master
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#EXT-X-MEDIA") && l.includes('URI="'))
    .map((l) => /URI="([^"]+)"/.exec(l)?.[1])
    .filter((u): u is string => Boolean(u));

export const rewriteMaster = (
  master: string,
  build: { variantUrl: (variantUri: string) => string; renditionUrl: (uri: string) => string }
): string =>
  master
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_m, u: string) => `URI="${build.renditionUrl(u)}"`);
      }
      return isUriLine(trimmed) ? build.variantUrl(trimmed) : line;
    })
    .join("\n");

export const rewriteVariant = (
  variant: string,
  build: { keyUrl: string; segmentUrl: (segmentUri: string) => string }
): string =>
  variant
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        return trimmed.includes(HLS_KEY_URI_PLACEHOLDER) ? line.replace(HLS_KEY_URI_PLACEHOLDER, build.keyUrl) : line;
      }
      return isUriLine(trimmed) ? build.segmentUrl(trimmed) : line;
    })
    .join("\n");

/**
 * Thumbnail VTT: cues reference sprite sheets relatively
 * ("sprite_000.jpg#xywh=0,0,160,90"). A relative reference would resolve
 * against the API URL and lose the signature, so each is rewritten to an
 * absolute signed URL, preserving the media fragment.
 */
export const collectSpriteUris = (vtt: string): string[] => {
  const out = new Set<string>();
  for (const line of vtt.split("\n")) {
    const m = /^([^\s#][^\s#]*\.(?:jpg|jpeg|png|webp))(#xywh=[\d,]+)?\s*$/i.exec(line.trim());
    if (m?.[1]) out.add(m[1]);
  }
  return [...out];
};

export const rewriteThumbnailsVtt = (vtt: string, spriteUrl: (spriteUri: string) => string): string =>
  vtt
    .split("\n")
    .map((line) => {
      const m = /^([^\s#][^\s#]*\.(?:jpg|jpeg|png|webp))(#xywh=[\d,]+)?\s*$/i.exec(line.trim());
      return m?.[1] ? `${spriteUrl(m[1])}${m[2] ?? ""}` : line;
    })
    .join("\n");

/** Reject anything that could escape the video's prefix. */
export const isSafeRelativePath = (p: string): boolean =>
  p.length > 0 &&
  p.length < 256 &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !p.includes("?") &&
  !p.includes("#") &&
  p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..") &&
  /^[A-Za-z0-9._/-]+$/.test(p);
