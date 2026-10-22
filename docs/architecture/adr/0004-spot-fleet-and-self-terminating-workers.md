# ADR-0004: Spot fleet scaled from the queue, workers terminate themselves

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Transcoding is bursty: nothing for hours, then a batch of uploads. Idle
encoders are pure cost. The work is CPU-bound, resumable (a lost transcode
just restarts), and tolerant of minute-scale start-up latency. That is the
ideal Spot workload.

Autoscaling groups scale on metrics with lag and terminate instances of their
own choosing, which can kill a worker in the middle of an encode.

## Decision

- A small **orchestrator** runs every minute (a Lambda on EventBridge
  Scheduler in AWS, a loop locally). Each tick it:
  1. reaps stale claims,
  2. counts `queued` and `in_progress` work in one query,
  3. counts running and pending workers by role tag,
  4. launches `min(ceil(queued / DIVISOR) - spare, MAX_WORKERS - running)` workers,
     where `spare = running - in_progress`.
- Launch uses **EC2 Fleet `instant`** across *every subnet (AZ) x instance-type*
  pair, walking a strict preference ladder: each type is tried across all AZs
  before falling back to the next. One AZ's Spot pool running dry cannot stall
  the fleet. On-demand fallback is opt-in.
- **The orchestrator never terminates instances.** A worker terminates itself
  after `IDLE_GRACE_MS` with nothing to claim, so only an idle worker ever goes
  away, never a busy one.
- On a **Spot interruption notice** (IMDSv2), the worker releases its claim
  without consuming an attempt. Another worker resumes the video.
- An optional **second pool** with its own launch template and role tag serves
  background jobs (captions, MP4) on smaller instances, so a heavy transcode
  and a light job never compete for the same machine size.

## Consequences

**Good**
- Zero compute cost when idle. Spot Graviton at roughly a third of on-demand x86 prices.
- Workers are never killed mid-job by the scaler.
- The scaling decision is a pure function (`apps/orchestrator/src/controller.ts`), unit-tested on its own.
- Self-termination needs **no EC2 API permission at all**. The worker runs
  `shutdown -h now`, and the launch template sets
  `instance_initiated_shutdown_behavior = terminate`, so the operating system
  ending is the instance ending. A compromised worker therefore cannot
  terminate (or even describe) any other instance.

**Bad**
- One-minute scheduling granularity plus instance boot (about 60-90 s from an
  AMI) is the floor on time-to-first-frame for a cold fleet. Raise
  `MAX_WORKERS` headroom or keep a warm worker if that matters.
