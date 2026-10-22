/**
 * Pure scale-up math for ONE worker pool. No I/O, so it is exhaustively unit-tested.
 *
 *   need     = ceil(queued / divisor)                  workers wanted for the backlog
 *   spare    = max(0, running - inProgress)            workers not on an item
 *   toLaunch = max(0, min(need - spare, maxWorkers - running))
 *
 * Why 'processing' is NOT in the numerator: a processing item ALREADY has a
 * worker, so feeding it into the launch count (and subtracting all `running`)
 * double-counts and over-launches whenever `running` momentarily undercounts
 * that worker, which happens for ordinary reasons (still booting, role tag not
 * yet visible to DescribeInstances, or Spot-reclaimed before its claim was
 * reaped). Provisioning off the queue and subtracting only SPARE workers is
 * immune both ways: an uncounted busy worker cannot inflate the launch (spare
 * clamps at 0), and a busy worker cannot suppress a needed launch (it is
 * excluded from spare). With divisor=1 this is one worker per queued item,
 * capped by maxWorkers. The controller never terminates instances: workers
 * self-terminate when the queue stays empty.
 */
export interface PoolInput {
  queued: number;
  inProgress: number;
  running: number;
  maxWorkers: number;
  divisor: number;
}

export interface PoolPlan {
  need: number;
  spare: number;
  toLaunch: number;
}

export const planPool = ({ queued, inProgress, running, maxWorkers, divisor }: PoolInput): PoolPlan => {
  const safeDivisor = Math.max(1, Math.floor(divisor));
  const spare = Math.max(0, running - inProgress);
  const need = Math.ceil(Math.max(0, queued) / safeDivisor);
  const toLaunch = Math.max(0, Math.min(need - spare, Math.max(0, maxWorkers - running)));
  return { need, spare, toLaunch };
};
