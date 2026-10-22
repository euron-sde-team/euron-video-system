# ADR-0001: Postgres is the work queue

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Every uploaded video needs exactly one worker to transcode it, then one worker
each for captions and the downloadable MP4. Workers are EC2 Spot instances that
can disappear with two minutes' notice. The control plane already needs
Postgres for videos, keys, sessions and the audit log.

The usual answer is a broker: SQS, RabbitMQ, or Redis with BullMQ. Each adds a
second source of truth for "what state is this video in", plus the work of
keeping the broker and the database consistent (the dual-write problem). For
example, a message is acknowledged but the row update fails, or the row says
`processing` while the message went back to the queue.

Our workload is low-volume and long-running: tens to thousands of jobs a day,
each taking minutes to hours. Throughput is never the bottleneck. Correctness
under crashes is.

## Decision

The `videos` table **is** the primary queue and the `jobs` table is the
background queue. There is no broker.

- **Claim:** `UPDATE ... WHERE id = (SELECT id ... WHERE status = 'uploaded' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
  Concurrent workers each atomically get a different row, with no thundering herd and no double claim.
- **Ownership:** every later write is guarded by
  `WHERE id = $id AND locked_by = $worker AND status = 'processing'` and reports
  whether it landed. A worker that lost its claim can never overwrite a row
  another worker now owns.
- **Liveness:** workers heartbeat every 30 s. A reaper requeues rows whose
  heartbeat is older than 10 minutes or whose claim is older than 6 hours, up
  to `max_attempts`. After that the row goes terminal `failed`.
- **Cancellation is cooperative:** cancel flips the status, the next heartbeat
  matches zero rows, and the worker's `AbortController` kills FFmpeg.
- **Spot interruption** releases the claim *without* consuming an attempt.
- State transitions and their consequences (follow-up jobs, webhook outbox
  rows, usage counters) commit in **one transaction**.

## Consequences

**Good**
- One source of truth: a video's queue state *is* its row, and the API reads it with no extra lookup.
- Exactly-once state transitions without distributed transactions.
- Every transition and its side effects are atomic, which is what makes the
  webhook outbox (ADR-0006 and LLD) trivially correct.
- One fewer system to provision, secure, monitor and pay for. Local development needs only Postgres.

**Bad**
- Polling. Workers poll every `POLL_MS` (5 s). This costs a few indexed queries
  per worker per poll interval, and partial indexes on `status = 'uploaded'` and
  `status = 'processing'` keep each one at index-only cost no matter how large
  the catalog grows. `LISTEN/NOTIFY` could remove the latency floor; 5 s is
  irrelevant next to a multi-minute transcode.
- Not built for very high fan-out (say, 10k jobs/s). If the workload ever
  needs that, the claim and heartbeat interface in `packages/core/src/queue` is
  narrow enough to put a broker behind it.

## Alternatives considered

- **SQS + visibility timeout:** brings in the dual-write problem. Visibility
  timeouts also have to be tuned against multi-hour encodes, extended by heartbeats anyway.
- **BullMQ on Redis:** a second stateful store to run highly available. Its
  delivery guarantees are weaker than a database transaction.
- **Step Functions:** a good fit for orchestration, but the state would live
  outside the database the API reads, and it has no local emulation story as
  simple as Postgres.
