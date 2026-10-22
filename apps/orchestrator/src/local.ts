import "./env.js";
import { getOrchestratorConfig } from "@evs/core/config";
import logger from "@evs/core/logger";
import { createLauncher, runTick } from "./tick.js";

/**
 * Long-running loop for docker compose and other non-Lambda environments. Runs
 * the exact tick the Lambda runs, every ORCHESTRATOR_INTERVAL_MS. Ticks never
 * overlap: the next one is scheduled only after the previous finished.
 */
const cfg = getOrchestratorConfig();
const launcher = createLauncher(cfg);
let stopped = false;
let timer: NodeJS.Timeout | null = null;

const loop = async (): Promise<void> => {
  if (stopped) return;
  try {
    await runTick(launcher, cfg);
  } catch (err) {
    logger.error(`[orchestrator] tick failed: ${(err as Error).message}`);
  }
  if (!stopped) timer = setTimeout(() => void loop(), cfg.ORCHESTRATOR_INTERVAL_MS);
};

const stop = (sig: string): void => {
  logger.info(`[orchestrator] ${sig} received; stopping`);
  stopped = true;
  if (timer) clearTimeout(timer);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

logger.info(`[orchestrator] local loop every ${cfg.ORCHESTRATOR_INTERVAL_MS}ms (launcher=${launcher.name})`);
void loop();
