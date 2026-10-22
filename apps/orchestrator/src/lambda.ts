import "./env.js";
import { getOrchestratorConfig } from "@evs/core/config";
import { createLauncher, runTick, type TickResult } from "./tick.js";

/**
 * Lambda entry point, invoked by an EventBridge Scheduler rule every minute.
 * The launcher is created once per execution environment (the EC2 client is
 * safe to reuse); the database client is opened per invocation inside runTick.
 */
const cfg = getOrchestratorConfig();
const launcher = createLauncher(cfg);

export const handler = async (): Promise<TickResult> => runTick(launcher, cfg);
