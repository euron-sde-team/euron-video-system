import { getOrchestratorConfig, type OrchestratorConfig } from "@evs/core/config";
import { resolveConnectionConfig } from "@evs/core/db/connection";
import logger from "@evs/core/logger";
import {
  COUNT_QUEUE_SQL,
  JOB_CANCEL_SQL,
  JOB_COUNT_SQL,
  JOB_REAP_SQL,
  JOB_RECONCILE_SQL,
  REAP_SQL,
} from "@evs/core/queue/sql";
import pg from "pg";
import { planPool } from "./controller.js";
import { Ec2SpotLauncher } from "./ec2.js";
import { NoopLauncher, type Launcher, type WorkerPool } from "./launcher.js";

export interface TickResult {
  reaped: number;
  queued: number;
  inProgress: number;
  running: number;
  spare: number;
  toLaunch: number;
  launched: number;
}

export const createLauncher = (cfg: OrchestratorConfig): Launcher =>
  cfg.LAUNCHER === "ec2-spot" ? new Ec2SpotLauncher(cfg) : new NoopLauncher();

const primaryPool = (cfg: OrchestratorConfig): WorkerPool => ({
  instanceTypes: cfg.WORKER_INSTANCE_TYPES,
  roleTag: cfg.WORKER_ROLE_TAG,
  launchTemplateName: cfg.LAUNCH_TEMPLATE_NAME ?? "",
});

const jobsPool = (cfg: OrchestratorConfig): WorkerPool => ({
  instanceTypes: cfg.JOBS_INSTANCE_TYPES,
  roleTag: cfg.JOBS_ROLE_TAG,
  launchTemplateName: cfg.JOBS_LAUNCH_TEMPLATE_NAME ?? "",
});

/**
 * One controller tick: reap dead claims, then scale UP only.
 *
 * A dedicated pg Client is opened PER TICK and closed in finally. There is no
 * module-scope pool on purpose: inside Lambda a pool would leak connections
 * across frozen/thawed execution environments. On AWS the password is resolved
 * from the RDS-managed secret per connection, so rotation needs no redeploy.
 *
 * The backlog spans TWO queues: unclaimed videos ('uploaded') and unclaimed
 * background jobs ('queued' CAPTIONS/DOWNLOAD). With a single pool their sums
 * feed one plan; with a separate jobs pool (JOBS_LAUNCH_TEMPLATE_NAME set) each
 * queue drives its own pool, so a small jobs instance never picks up a heavy
 * transcode and big instances aren't spent on whisper.
 */
export const runTick = async (launcher: Launcher, cfg = getOrchestratorConfig()): Promise<TickResult> => {
  // DATABASE_URL, or DATABASE_SECRET_ARN + DB_* on AWS. The password cache lives
  // at module scope, so a warm Lambda reuses it across ticks (one Secrets
  // Manager call per minute at most) while a rotation is still picked up.
  const db = new pg.Client(resolveConnectionConfig(process.env));
  await db.connect();
  try {
    // Reap both queues, then reconcile the denormalized videos.*_status for any
    // job the reaper (not a worker) terminally failed, so no UI sticks on "preparing".
    const reapRes = await db.query(REAP_SQL);
    const jobReapRes = await db.query(JOB_REAP_SQL);
    await db.query(JOB_RECONCILE_SQL);
    // Retire queued jobs of cancelled parents BEFORE counting, so the launch
    // math never provisions workers for jobs claimNextJob refuses anyway.
    await db.query(JOB_CANCEL_SQL);
    const reaped = (reapRes.rowCount ?? 0) + (jobReapRes.rowCount ?? 0);

    const v = (await db.query<{ queued: number; in_progress: number }>(COUNT_QUEUE_SQL)).rows[0];
    const j = (await db.query<{ queued: number; in_progress: number }>(JOB_COUNT_SQL)).rows[0];
    const videoQueued = v?.queued ?? 0;
    const videoInProgress = v?.in_progress ?? 0;
    const jobQueued = j?.queued ?? 0;
    const jobInProgress = j?.in_progress ?? 0;

    if (cfg.JOBS_LAUNCH_TEMPLATE_NAME) {
      const pRunning = await launcher.countWorkers(primaryPool(cfg));
      const p = planPool({
        queued: videoQueued,
        inProgress: videoInProgress,
        running: pRunning,
        maxWorkers: cfg.MAX_WORKERS,
        divisor: cfg.DIVISOR,
      });
      const jRunning = await launcher.countWorkers(jobsPool(cfg));
      const jp = planPool({
        queued: jobQueued,
        inProgress: jobInProgress,
        running: jRunning,
        maxWorkers: cfg.JOBS_MAX_WORKERS,
        divisor: cfg.DIVISOR,
      });
      logger.info(
        `[orchestrator] reaped=${reaped} primary[q=${videoQueued} proc=${videoInProgress} run=${pRunning} ` +
          `launch=${p.toLaunch}] jobs[q=${jobQueued} proc=${jobInProgress} run=${jRunning} launch=${jp.toLaunch}]`
      );
      let launched = 0;
      if (p.toLaunch > 0) launched += (await launcher.launch(p.toLaunch, primaryPool(cfg))).length;
      if (jp.toLaunch > 0) launched += (await launcher.launch(jp.toLaunch, jobsPool(cfg))).length;
      return {
        reaped,
        queued: videoQueued + jobQueued,
        inProgress: videoInProgress + jobInProgress,
        running: pRunning + jRunning,
        spare: p.spare + jp.spare,
        toLaunch: p.toLaunch + jp.toLaunch,
        launched,
      };
    }

    // Single pool: one fleet drains BOTH queues; workers run WORKER_MODE=all
    // (videos first, then jobs).
    const queued = videoQueued + jobQueued;
    const inProgress = videoInProgress + jobInProgress;
    const running = await launcher.countWorkers(primaryPool(cfg));
    const s = planPool({ queued, inProgress, running, maxWorkers: cfg.MAX_WORKERS, divisor: cfg.DIVISOR });

    logger.info(
      `[orchestrator] reaped=${reaped} queued=${queued}(v=${videoQueued},j=${jobQueued}) ` +
        `processing=${inProgress}(v=${videoInProgress},j=${jobInProgress}) ` +
        `running=${running} spare=${s.spare} need=${s.need} toLaunch=${s.toLaunch} launcher=${launcher.name}`
    );

    const launched = s.toLaunch > 0 ? (await launcher.launch(s.toLaunch, primaryPool(cfg))).length : 0;
    return { reaped, queued, inProgress, running, spare: s.spare, toLaunch: s.toLaunch, launched };
  } finally {
    await db.end();
  }
};
