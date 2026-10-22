/**
 * Turn an internal failure into the message stored on the video row, which the
 * API returns to clients and the console shows to operators.
 *
 * Raw errors carry worker internals: absolute scratch paths, FFmpeg's memory
 * addresses, multi-kilobyte stderr tails. That is noise for a caller and a
 * small information disclosure. Recognized failures become one clear sentence;
 * anything else is scrubbed and truncated. The full detail always stays in the
 * worker log, keyed by video id, for operators.
 */

const MAX_PUBLIC_LENGTH = 300;

/** Known failure signatures, checked in order. First match wins. */
const KNOWN: Array<{ test: RegExp; message: (m: RegExpMatchArray) => string }> = [
  {
    test: /moov atom not found|Invalid data found when processing input|could not find codec parameters/i,
    message: () =>
      "The source file is not a readable video. It may be truncated or corrupt (container index missing or unreadable).",
  },
  { test: /does not contain any stream|no video stream/i, message: () => "The source file has no video stream." },
  {
    test: /NoSuchKey|source .* not found in storage|404 Not Found/i,
    message: () => "The source upload is missing from storage. Upload the file again.",
  },
  { test: /ENOSPC|No space left on device/i, message: () => "The worker ran out of scratch disk space. It will be retried." },
  { test: /SIGKILL|out of memory|Cannot allocate memory/i, message: () => "Transcoding was interrupted by the worker (resource limits)." },
];

/** Strip host-specific detail: absolute paths, pointers, ANSI codes, whitespace runs. */
export const scrub = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
    .replace(/0x[0-9a-f]{6,}/gi, "<addr>")
    .replace(/\s+/g, " ")
    .trim();

export const toPublicError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  for (const { test, message } of KNOWN) {
    const match = raw.match(test);
    if (match) return message(match);
  }
  const cleaned = scrub(raw);
  return cleaned.length > MAX_PUBLIC_LENGTH ? `${cleaned.slice(0, MAX_PUBLIC_LENGTH - 1)}…` : cleaned || "Transcoding failed.";
};
