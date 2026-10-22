import {
  CreateFleetCommand,
  CreateTagsCommand,
  DescribeInstancesCommand,
  EC2Client,
  type CreateFleetCommandInput,
  type FleetLaunchTemplateOverridesRequest,
  type SpotAllocationStrategy,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import type { OrchestratorConfig } from "@evs/core/config";
import logger from "@evs/core/logger";
import type { Launcher, WorkerPool } from "./launcher.js";

/**
 * Fleet overrides = the cartesian product of the GIVEN instance types and every
 * worker subnet (one per AZ). Each (subnet, type) pair is a distinct Spot
 * capacity pool; handing the fleet all the pools for a tier lets the allocation
 * strategy pick the deepest one and route around an exhausted AZ instead of
 * failing with InsufficientInstanceCapacity.
 */
export const buildOverrides = (subnetIds: string[], instanceTypes: string[]): FleetLaunchTemplateOverridesRequest[] => {
  const subnets = subnetIds.length ? subnetIds : [undefined];
  const overrides: FleetLaunchTemplateOverridesRequest[] = [];
  for (const subnet of subnets) {
    for (const instanceType of instanceTypes) {
      overrides.push({ ...(subnet ? { SubnetId: subnet } : {}), InstanceType: instanceType as _InstanceType });
    }
  }
  return overrides;
};

/**
 * EC2 Spot capacity via CreateFleet (type=instant).
 *
 * Workers are counted from EC2, NOT a DB table: a self-reported table goes
 * stale the instant a Spot instance is reclaimed. `pending` (booting) MUST be
 * counted alongside `running`, or the controller relaunches a whole fleet every
 * minute while the first batch is still booting.
 */
export class Ec2SpotLauncher implements Launcher {
  readonly name = "ec2-spot";
  private readonly ec2: EC2Client;

  constructor(
    private readonly cfg: OrchestratorConfig,
    region = process.env.AWS_REGION ?? "us-east-1"
  ) {
    this.ec2 = new EC2Client({ region });
  }

  async countWorkers(pool: WorkerPool): Promise<number> {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const res = await this.ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:role", Values: [pool.roleTag] },
            { Name: "instance-state-name", Values: ["pending", "running"] },
          ],
          NextToken: nextToken,
        })
      );
      for (const reservation of res.Reservations ?? []) count += (reservation.Instances ?? []).length;
      nextToken = res.NextToken;
    } while (nextToken);
    return count;
  }

  /**
   * `instant` fleet: synchronous, returns the launched instance ids (and any
   * per-pool errors) instead of managing capacity over time. The launch template
   * carries everything fixed (AMI, instance profile, security group, IMDSv2,
   * shutdown=terminate); only the cost/capacity knobs are overridden here. The
   * template must NOT set InstanceMarketOptions: the fleet's
   * DefaultTargetCapacityType decides Spot vs On-Demand.
   */
  private fleetInput(count: number, useSpot: boolean, instanceTypes: string[], ltName: string): CreateFleetCommandInput {
    return {
      Type: "instant",
      TargetCapacitySpecification: {
        TotalTargetCapacity: count,
        DefaultTargetCapacityType: useSpot ? "spot" : "on-demand",
      },
      ...(useSpot
        ? {
            // Within THIS tier's pools (one type across the AZs), pick the AZ with
            // the best capacity. It does NOT choose between types: the strict
            // type preference lives in the tiering in launch(), not here.
            SpotOptions: { AllocationStrategy: this.cfg.SPOT_ALLOCATION_STRATEGY as SpotAllocationStrategy },
          }
        : { OnDemandOptions: { AllocationStrategy: "lowest-price" } }),
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: { LaunchTemplateName: ltName, Version: this.cfg.LAUNCH_TEMPLATE_VERSION },
          Overrides: buildOverrides(this.cfg.WORKER_SUBNET_IDS, instanceTypes),
        },
      ],
    };
  }

  /**
   * Ask EC2 to launch `count` of ONLY `instanceTypes`, across all AZs, right now.
   * This IS the availability check: pools without capacity come back in
   * `Errors` (InsufficientInstanceCapacity / UnfulfillableCapacity), NOT as a
   * thrown exception, so each is logged and whatever launched is returned. No
   * guessing from stale price history: EC2's allocator answers in real time.
   */
  private async createFleet(
    count: number,
    useSpot: boolean,
    instanceTypes: string[],
    label: string,
    ltName: string
  ): Promise<string[]> {
    try {
      const res = await this.ec2.send(new CreateFleetCommand(this.fleetInput(count, useSpot, instanceTypes, ltName)));
      const ids = (res.Instances ?? []).flatMap((i) => i.InstanceIds ?? []);
      for (const e of res.Errors ?? []) {
        logger.warn(`[orchestrator] fleet(${label}) pool error: ${e.ErrorCode ?? "?"} ${e.ErrorMessage ?? ""}`.trim());
      }
      return ids;
    } catch (err) {
      logger.error(`[orchestrator] CreateFleet(${label}) threw: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Launch up to N workers with a STRICT instance-type preference LADDER. Each
   * type, in order, is tried ALONE across all AZs for only the capacity the
   * higher-preference types could NOT supply this tick. So the second type is
   * used only once the first is unavailable in every AZ, and so on: never while
   * a more-preferred size still has room.
   *
   * Spot-only by default: if no Spot pool for any type has capacity, nothing is
   * launched and the backlog stays queued (the next tick retries).
   * ONDEMAND_FALLBACK opts in to covering the remainder On-Demand, so a long job
   * never restarts forever on repeated Spot loss. Instances are tagged here so
   * the `role` tag is authoritative for countWorkers even if a launch template
   * omits it.
   */
  async launch(n: number, pool: WorkerPool): Promise<string[]> {
    const ids: string[] = [];
    const { instanceTypes, roleTag, launchTemplateName: lt } = pool;

    for (const type of instanceTypes) {
      if (ids.length >= n) break;
      const shortfall = n - ids.length;
      const launched = await this.createFleet(shortfall, true, [type], `spot:${roleTag}:${type}`, lt);
      if (launched.length < shortfall) {
        logger.warn(
          `[orchestrator] ${type} gave ${launched.length}/${shortfall} (short in all AZs); ` +
            "spilling the remainder to the next-preferred type"
        );
      }
      ids.push(...launched);
    }

    if (ids.length < n && this.cfg.ONDEMAND_FALLBACK) {
      const shortfall = n - ids.length;
      logger.warn(`[orchestrator] Spot gave ${ids.length}/${n}; On-Demand fallback for ${shortfall}`);
      ids.push(...(await this.createFleet(shortfall, false, instanceTypes, `on-demand:${roleTag}`, lt)));
    }

    if (ids.length > 0) {
      await this.ec2.send(new CreateTagsCommand({ Resources: ids, Tags: [{ Key: "role", Value: roleTag }] }));
    }
    logger.info(`[orchestrator] launched ${ids.length}/${n} ${roleTag} worker(s): ${ids.join(", ")}`);
    return ids;
  }
}
