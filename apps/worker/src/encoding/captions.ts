import { access } from "node:fs/promises";
import path from "node:path";
import { getWorkerConfig } from "@evs/core/config";
import logger from "@evs/core/logger";
import { OwnershipLostError, run } from "./exec.js";

export interface CaptionsResult {
  vttFile: string;
  lang: string;
}

/**
 * Generate captions on the worker with whisper.cpp.
 *   1. ffmpeg extracts 16 kHz mono PCM WAV (what whisper expects).
 *   2. whisper.cpp transcribes to <lang>.vtt.
 * The language is FORCED (`-l <lang>`), defaulting to CAPTIONS_DEFAULT_LANG, so
 * transcription is deterministic instead of relying on whisper's auto-detect.
 *
 * Returns null when the source has no audio. Caption generation itself is
 * non-fatal: any failure (the WAV extraction OR whisper) yields null, because a
 * video without captions is still a valid result. The failure is logged at
 * ERROR with the underlying stderr (not a quiet warn) so a missing whisper model
 * or renamed binary in the worker image is actually visible.
 */
export const generateCaptions = async (
  inputPath: string,
  workDir: string,
  hasAudio: boolean,
  lang: string = getWorkerConfig().CAPTIONS_DEFAULT_LANG,
  signal?: AbortSignal
): Promise<CaptionsResult | null> => {
  if (!hasAudio) return null;
  const cfg = getWorkerConfig();

  const wavPath = path.join(workDir, "audio16k.wav");
  const outPrefix = path.join(workDir, lang); // whisper.cpp appends .vtt
  const vttFile = `${outPrefix}.vtt`;

  try {
    await run(
      cfg.FFMPEG_BIN,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      "ffmpeg-wav",
      { signal }
    );
    await run(
      cfg.WHISPER_BIN,
      ["-m", cfg.WHISPER_MODEL, "-l", lang, "-f", wavPath, "-ovtt", "-of", outPrefix],
      "whisper",
      { signal }
    );
    await access(vttFile);
    return { vttFile, lang };
  } catch (err) {
    // A cancellation abort is NOT a whisper failure: rethrow it so routine
    // cancels never pollute the whisper-breakage ERROR signal below.
    if (err instanceof OwnershipLostError) throw err;
    logger.error(`[captions] generation failed: ${(err as Error).message}`);
    return null;
  }
};
