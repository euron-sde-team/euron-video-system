import { spawn } from "node:child_process";
import logger from "@evs/core/logger";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Thrown when a job is cancelled mid-flight because the worker lost ownership of
 * its claim (the video/job was cancelled, retried, reaped, or re-claimed). The
 * worker's catch treats it like any failure, but the guarded markReady /
 * markJobDone / failOrRequeue writes then no-op, so the other actor's state wins.
 */
export class OwnershipLostError extends Error {
  constructor(label = "worker") {
    super(`[${label}] aborted: ownership lost (video/job reclaimed, cancelled, or retried)`);
    this.name = "OwnershipLostError";
  }
}

/**
 * Spawn a binary and await completion. Rejects on non-zero exit with the tail of
 * stderr (ffmpeg and whisper write progress + errors there). Output is streamed
 * rather than buffered whole because transcode logs can be large.
 *
 * Cancellation: pass `opts.signal`. On abort the child is SIGKILLed, so a
 * multi-hour ffmpeg/whisper stops in milliseconds. Only the child is killed
 * (never the DB pool), so the worker cleanly loops to its next claim. The single
 * `close` handler settles the promise (checking `signal.aborted` for a clear
 * message), so it never rejects twice.
 */
export const run = (
  bin: string,
  args: string[],
  label: string,
  opts?: { cwd?: string; signal?: AbortSignal }
): Promise<RunResult> => {
  return new Promise((resolve, reject) => {
    const signal = opts?.signal;
    if (signal?.aborted) {
      reject(new OwnershipLostError(label));
      return;
    }
    logger.debug(`[exec ${label}] ${bin} ${args.join(" ")}`);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts?.cwd });

    let stdout = "";
    let stderrTail = "";
    const TAIL = 8000;

    // On abort: SIGKILL the child. The `close` handler below (which always fires
    // after a kill, with a non-zero/null code) is the single settle point.
    const onAbort = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-TAIL);
    });

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`[${label}] spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new OwnershipLostError(label));
      } else if (code === 0) {
        resolve({ stdout, stderr: stderrTail });
      } else {
        reject(new Error(`[${label}] exited ${code}: ${stderrTail.slice(-2000)}`));
      }
    });
  });
};
