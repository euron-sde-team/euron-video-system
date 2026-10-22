import { describe, expect, it } from "vitest";
import { planPool } from "../src/controller.js";
import { buildOverrides } from "../src/ec2.js";

const base = { queued: 0, inProgress: 0, running: 0, maxWorkers: 20, divisor: 1 };

describe("planPool", () => {
  it("launches nothing for an empty queue", () => {
    expect(planPool(base)).toEqual({ need: 0, spare: 0, toLaunch: 0 });
  });

  it("launches one worker per queued item with divisor 1", () => {
    expect(planPool({ ...base, queued: 5 }).toLaunch).toBe(5);
  });

  it("reuses spare (idle) workers before launching", () => {
    expect(planPool({ ...base, queued: 5, running: 3, inProgress: 1 })).toEqual({ need: 5, spare: 2, toLaunch: 3 });
  });

  it("does not count in-progress items as demand", () => {
    expect(planPool({ ...base, queued: 0, inProgress: 4, running: 4 }).toLaunch).toBe(0);
  });

  it("a busy worker missing from the EC2 count cannot inflate the launch", () => {
    // 2 processing, only 1 visible yet: spare clamps at 0, launch = queued only.
    expect(planPool({ ...base, queued: 1, inProgress: 2, running: 1 })).toEqual({ need: 1, spare: 0, toLaunch: 1 });
  });

  it("respects maxWorkers", () => {
    expect(planPool({ ...base, queued: 50, running: 18, inProgress: 18 }).toLaunch).toBe(2);
    expect(planPool({ ...base, queued: 50, running: 25, inProgress: 25 }).toLaunch).toBe(0);
  });

  it("batches with a larger divisor and tolerates a bad divisor", () => {
    expect(planPool({ ...base, queued: 7, divisor: 3 }).toLaunch).toBe(3);
    expect(planPool({ ...base, queued: 4, divisor: 0 }).toLaunch).toBe(4);
  });
});

describe("buildOverrides", () => {
  it("is the subnet x instance-type product", () => {
    const o = buildOverrides(["subnet-a", "subnet-b"], ["c7g.xlarge", "m7g.xlarge"]);
    expect(o).toHaveLength(4);
    expect(o[0]).toEqual({ SubnetId: "subnet-a", InstanceType: "c7g.xlarge" });
    expect(o[3]).toEqual({ SubnetId: "subnet-b", InstanceType: "m7g.xlarge" });
  });

  it("omits SubnetId when none are configured", () => {
    expect(buildOverrides([], ["c7g.xlarge"])).toEqual([{ InstanceType: "c7g.xlarge" }]);
  });
});
