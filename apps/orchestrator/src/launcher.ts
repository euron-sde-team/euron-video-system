import logger from "@evs/core/logger";

/** One fleet of interchangeable workers, identified by its role tag. */
export interface WorkerPool {
  instanceTypes: string[];
  roleTag: string;
  launchTemplateName: string;
}

/**
 * Where worker capacity comes from. The controller is identical regardless:
 * it asks how many workers a pool has, then asks for N more.
 */
export interface Launcher {
  readonly name: string;
  /** Workers that exist or are about to (pending + running) for a pool. */
  countWorkers(pool: WorkerPool): Promise<number>;
  /** Launch up to `count` workers. Returns the ids actually launched. */
  launch(count: number, pool: WorkerPool): Promise<string[]>;
}

/**
 * Local / demo launcher. Workers in docker compose are long-lived containers,
 * so there is nothing to launch: this logs the decision the EC2 launcher would
 * have made, which is exactly what you want to watch in a demo.
 */
export class NoopLauncher implements Launcher {
  readonly name = "noop";

  async countWorkers(): Promise<number> {
    return 0;
  }

  async launch(count: number, pool: WorkerPool): Promise<string[]> {
    logger.info(`[orchestrator] (noop) would launch ${count} ${pool.roleTag} worker(s)`);
    return [];
  }
}
