/** Upload extensions accepted at create time. Lowercase, no dot. */
export const ALLOWED_UPLOAD_EXT = new Set(["mp4", "mov", "mkv", "webm", "m4v"]);

/**
 * Object-key conventions, shared by the worker (writer) and the API (reader /
 * signer) so the two can never drift. Each bucket has a single purpose:
 *
 *   uploads    uploads/{id}/original.{ext}     raw source, lifecycle-expired
 *   media      media/{id}/hls/...              encrypted HLS tree + poster + sprites
 *   downloads  downloads/{id}.mp4              processed MP4, presigned GET only
 */
export const objectKeys = {
  source: (videoId: string, ext: string): string => `uploads/${videoId}/original.${ext}`,
  outputPrefix: (videoId: string): string => `media/${videoId}`,
  download: (videoId: string): string => `downloads/${videoId}.mp4`,
} as const;

/** Files inside a video's output prefix. */
export const OUTPUT_FILES = {
  hlsMaster: "hls/master.m3u8",
  hlsDir: "hls",
  poster: "poster.jpg",
  thumbnailsDir: "thumbnails",
  thumbnailsVtt: "thumbnails/thumbnails.vtt",
} as const;

/**
 * Sentinel baked into every variant playlist's EXT-X-KEY URI at package time.
 * The playback token is per-viewer and does not exist when the worker packages,
 * so the API replaces this literal with the authorized, tokenized key URL on
 * every playlist request.
 */
export const HLS_KEY_URI_PLACEHOLDER = "EVS_KEY_URI";

/** Rung labels are digits only. Validated before they ever reach an object key. */
export const RUNG_LABEL = /^[0-9]{2,4}$/;
