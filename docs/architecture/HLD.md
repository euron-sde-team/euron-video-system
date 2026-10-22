# High-Level Design

This document describes what Euron Video System (EVS) is made of, how the pieces
talk to each other, and how the system behaves under load and failure. The
module-level detail is in the [Low-Level Design](LLD.md), the tables in the
[Data Model](data-model.md), and the reasoning behind each major choice in the
[ADRs](adr/README.md).

- [Goals and non-goals](#goals-and-non-goals)
- [System context](#system-context)
- [Containers](#containers)
- [Component responsibilities](#component-responsibilities)
- [Main flows](#main-flows)
- [Deployment topology](#deployment-topology)
- [Scalability](#scalability)
- [Availability and failure modes](#availability-and-failure-modes)
- [Security summary](#security-summary)
- [Observability](#observability)
- [Key design decisions](#key-design-decisions)

## Goals and non-goals

**Goals**

| # | Goal | How it is met |
| - | ---- | ------------- |
| G1 | Turn an uploaded file into adaptive HLS that plays on every modern browser and device | FFmpeg ABR ladder (up to 1080p), MPEG-TS segments, hls.js plus native Apple HLS |
| G2 | Only viewers authorized by the integrating platform can watch | Per-video AES-128 keys, token-gated key delivery, revocable playback sessions, signed segment URLs |
| G3 | Content keys stay in the operator's own cloud account | KMS envelope encryption with the video id as encryption context |
| G4 | No compute cost when idle; bounded queue latency when busy | Spot workers launched from queue depth, self-terminating when idle |
| G5 | Correct under worker loss, Spot reclaims and retries | Postgres queue with ownership-guarded writes, heartbeats and a reaper |
| G6 | A control plane, not just a pipeline | Scoped API keys, playback policies, webhooks, audit log, usage |
| G7 | Runnable on a laptop without an AWS account | Local AWS emulator provisioned by the same Terraform as production |

**Non-goals**

- **Hardware-backed DRM.** AES-128 HLS is access control with encryption; multi-DRM is
  on the roadmap ([ADR-0003](adr/0003-aes-128-hls-now-multi-drm-later.md)).
- **Multi-tenancy inside one deployment.** One deployment serves one organization
  ([ADR-0006](adr/0006-single-tenant-deployments.md)).
- **End-user identity.** EVS never sees your users; your backend decides who may
  watch and mints a session for an opaque `viewerId`.
- **Live streaming.** Video on demand only.

## System context

C4 level 1: EVS and the actors around it.

```mermaid
flowchart LR
  operator["Operator<br/>(console user)"]
  platform["Integrating platform<br/>(your backend)"]
  viewer["Viewer<br/>(player in a browser or app)"]
  evs["Euron Video System<br/>(one deployment, one organization)"]
  aws["AWS account services<br/>S3 · CloudFront · KMS · Secrets Manager · RDS · EC2 · Lambda"]

  operator -- "manage videos, keys, policies, webhooks" --> evs
  platform -- "upload, mint playback sessions (API key)" --> evs
  evs -- "signed webhooks" --> platform
  viewer -- "playlists + AES key (playback token)" --> evs
  viewer -- "encrypted segments (signed URLs)" --> aws
  evs -- "runs on" --> aws
```

## Containers

C4 level 2: the deployable units and their stores.

```mermaid
flowchart TB
  subgraph clients["Clients"]
    console["Console<br/>React SPA"]
    player["Player<br/>hls.js / native HLS"]
    platform["Platform backend"]
  end

  subgraph plane["Control plane"]
    api["API<br/>Express 5, Node cluster<br/>(apps/api)"]
    disp["Webhook dispatcher<br/>(runs inside each API process)"]
  end

  subgraph fleet["Transcode fleet"]
    orch["Orchestrator<br/>Lambda, every minute<br/>(apps/orchestrator)"]
    worker["Worker<br/>EC2 Spot, FFmpeg + whisper.cpp<br/>(apps/worker)"]
  end

  pg[("PostgreSQL 16<br/>state + work queues + outbox")]
  kms["KMS key"]
  sm["Secrets Manager"]
  s3u[("S3 uploads")]
  s3m[("S3 media")]
  s3d[("S3 downloads")]
  cf["CloudFront"]

  console --> api
  platform --> api
  disp --> platform
  player --> api
  player --> cf --> s3m
  platform -. "presigned POST" .-> s3u

  api --> pg
  api --> kms
  api --> sm
  api --> s3m
  api --> s3d
  disp --> pg

  orch --> pg
  orch -- "EC2 Fleet" --> worker
  worker --> pg
  worker --> kms
  worker --> s3u
  worker --> s3m
  worker --> s3d
```

## Component responsibilities

| Component | Code | Runs as | Owns | Never does |
| --------- | ---- | ------- | ---- | ---------- |
| API | [`apps/api`](../../apps/api) | ECS Fargate tasks, Node cluster per task | Authentication, authorization, video lifecycle, playback sessions, playlist rewriting, key delivery, audit, usage, webhook dispatch | Transcode, proxy upload bytes |
| Worker | [`apps/worker`](../../apps/worker) | EC2 Spot instances from a Packer AMI (or containers locally) | Claim, probe, transcode, thumbnails, generate and wrap the content key, package HLS, upload; captions and MP4 jobs | Decide scaling, unwrap keys |
| Orchestrator | [`apps/orchestrator`](../../apps/orchestrator) | Lambda on EventBridge Scheduler (or a loop locally) | Reap stale claims, count backlog and workers, launch Spot capacity | Terminate instances |
| Console | [`apps/console`](../../apps/console) | Static SPA behind nginx | Operator UI over the public API | Hold any credential other than the key pasted into it |
| Player | [`packages/player`](../../packages/player) | Inside the integrator's web app | Playback, quality and caption menus, thumbnail scrub, watermark, session refresh | Fetch keys outside the playlist flow |
| Shared runtime | [`packages/core`](../../packages/core) | Library | Config validation, DB pool, queue SQL, storage, envelope crypto, errors, logging | |

## Main flows

### Upload to ready

```mermaid
sequenceDiagram
    autonumber
    participant P as Platform
    participant API
    participant S3U as S3 uploads
    participant PG as Postgres
    participant O as Orchestrator
    participant W as Worker
    participant KMS
    participant S3M as S3 media

    P->>API: POST /v1/videos
    API->>PG: insert video (uploading)
    API-->>P: presigned POST
    P->>S3U: upload file (S3 enforces size and video/*)
    P->>API: POST /v1/videos/{id}/complete
    API->>S3U: HeadObject
    API->>PG: status uploaded + outbox video.uploaded
    O->>PG: reap, count queues
    O->>W: CreateFleet (Spot)
    W->>PG: claim (FOR UPDATE SKIP LOCKED)
    W->>S3U: download source
    W->>W: probe, ladder, transcode, thumbnails
    W->>KMS: Encrypt(content key, videoId)
    W->>PG: store wrapped key
    W->>W: package AES-128 HLS
    W->>S3M: upload tree
    W->>PG: one transaction: ready, renditions, jobs, usage, outbox video.ready
```

The video is playable at the last step. Captions and the downloadable MP4 are
separate jobs claimed afterwards, so they never delay time-to-watchable.

### Playback and key delivery

```mermaid
sequenceDiagram
    autonumber
    participant V as Viewer
    participant P as Platform
    participant API
    participant PG as Postgres
    participant KMS
    participant CDN as CloudFront

    V->>P: request to watch
    P->>P: entitlement check (yours)
    P->>API: POST /v1/videos/{id}/playback-sessions
    API->>PG: apply policy, insert session
    API-->>P: token, manifestUrl
    V->>API: master.m3u8?token
    API-->>V: variant URIs carry the token
    V->>API: {rung}/index.m3u8?token
    API-->>V: key URI tokenized, segment URIs signed
    V->>API: key?token
    API->>PG: session live? (cached 5 s)
    API->>KMS: Decrypt(wrapped key, videoId)
    API-->>V: 16 bytes, no-store
    V->>CDN: segments (signed)
```

### Webhook delivery

```mermaid
sequenceDiagram
    autonumber
    participant TX as State change (any transaction)
    participant PG as Postgres outbox
    participant D as Dispatcher (in API processes)
    participant R as Receiver

    TX->>PG: INSERT webhook_deliveries per subscribed endpoint (same transaction)
    loop every 2 s when idle
        D->>PG: claim due rows (FOR UPDATE SKIP LOCKED)
        D->>R: POST, EVS-Signature t=..,v1=..
        alt 2xx
            D->>PG: delivered
        else error or timeout
            D->>PG: pending, next_attempt_at = now() + backoff (or failed at max)
        end
    end
```

### Autoscaling

```mermaid
flowchart LR
  tick["Every minute"] --> reap["Reap stale claims<br/>(videos + jobs)"]
  reap --> count["COUNT queued / in progress"]
  count --> ec2["Count pending + running<br/>instances by role tag"]
  ec2 --> plan["planPool()<br/>need - spare, capped by MAX_WORKERS"]
  plan --> launch["EC2 Fleet instant<br/>type ladder × every subnet"]
  launch -.-> workers["Workers claim, then<br/>self-terminate when idle"]
```

## Deployment topology

### On AWS

```mermaid
flowchart TB
  subgraph vpc["VPC, 3 availability zones"]
    subgraph pub["Public subnets"]
      alb["ALB (TLS, ACM)"]
      nat["NAT gateway"]
    end
    subgraph priv["Private subnets"]
      ecs["ECS Fargate API tasks"]
      rds[("RDS PostgreSQL 16")]
      w["EC2 Spot workers"]
      l["Orchestrator Lambda"]
    end
    vpce["VPC endpoints: S3 gateway, KMS + Secrets Manager interface"]
  end
  cf["CloudFront + OAC"] --> s3[("S3: uploads, media, downloads")]
  alb --> ecs
  sch["EventBridge Scheduler"] --> l
  ecs --> rds
  w --> rds
  l --> rds
```

Provisioned by [`infra/terraform/envs/aws-prod`](../../infra/terraform/envs/aws-prod)
from ten modules under [`infra/terraform/modules`](../../infra/terraform/modules). The
worker AMI comes from [`infra/packer/worker.pkr.hcl`](../../infra/packer/worker.pkr.hcl).

### Locally

```mermaid
flowchart LR
  subgraph compose["docker compose (deploy/compose)"]
    floci["AWS emulator :4566"]
    tf["terraform (one-shot)"]
    pg[("postgres")]
    mig["migrate (one-shot)"]
    api["api :8080"]
    w1["worker"]
    w2["worker"]
    orch["orchestrator<br/>noop launcher"]
    con["console :3000"]
    rcv["webhook-receiver"]
  end
  tf --> floci
  mig --> pg
  api --> pg & floci
  w1 & w2 --> pg & floci
  orch --> pg
```

Differences from AWS are configuration only ([ADR-0005](adr/0005-local-aws-emulation.md)):
`AWS_ENDPOINT_URL` points the SDK at the emulator, workers run as fixed replicas with
`WORKER_PLATFORM=local`, the orchestrator uses the `noop` launcher, and segments are
served by the `proxy` delivery driver because the emulator's CloudFront is
management-plane only.

## Scalability

| Dimension | Scales by | Limit / bottleneck | Notes |
| --------- | --------- | ------------------ | ----- |
| Transcode throughput | More Spot workers (`MAX_WORKERS`, one per queued video by default) | Spot capacity per AZ and type; EC2 account limits | The instance-type ladder across every AZ widens the capacity pool |
| Time to first worker | n/a | Scheduler tick (1 min) + instance boot | Keep headroom or a warm worker if this matters |
| API requests | ECS tasks (CPU target tracking) × cluster workers per task | Postgres connections | Pool sizing: tasks × `CLUSTER_WORKERS` × `PG_POOL_MAX` + workers ≤ RDS `max_connections` |
| Playlist and key requests | Same as API | Revocation lookup is cached 5 s per process; no writes on the hot path except a batched key-delivery counter | Segments never touch the API with the CloudFront driver |
| Segment egress | CloudFront | CDN only | |
| Queue | Single Postgres table per queue | Claim and heartbeat are indexed point updates; partial indexes stay small | Built for long jobs, not 10k jobs per second ([ADR-0001](adr/0001-postgres-as-the-queue.md)) |
| Webhook fan-out | Every API process runs a dispatcher; `SKIP LOCKED` spreads rows | Receiver latency (10 s timeout) | Batches of 10 per claim |
| Rate limits | Per process, in memory | Effective limit grows with instance count | Swap in a shared store if exact global limits are required |

## Availability and failure modes

| Failure | Detection | Effect | Recovery |
| ------- | --------- | ------ | -------- |
| Worker process or instance dies mid-transcode | Heartbeat stops | Video stays `processing` | Reaper requeues after 10 min stale heartbeat (or 6 h absolute); retried up to `max_attempts` (3) |
| Spot interruption notice | IMDSv2 `spot/instance-action` polled every 5 s | Worker stops | Claim released immediately **without** consuming an attempt; next worker resumes |
| Video cancelled or claim stolen during encode | Guarded heartbeat matches 0 rows | Worker aborts | `AbortController` kills FFmpeg; partial output swept later |
| Poison video (always fails) | Error in pipeline | `attempts` grows | Terminal `failed` with a client-safe reason; `video.failed` webhook; pending artifacts resolved to `skipped` |
| API task dies | ALB health check on `/readyz` | In-flight requests fail | ECS replaces the task; in-flight webhook claims reaped after 5 min |
| Database failover (Multi-AZ) | Connection errors | Short write unavailability | Pools reconnect; boot uses exponential-backoff `waitForDatabase` |
| DB password rotation | n/a | None | Password read from Secrets Manager per new connection, cached 60 s |
| KMS throttling or outage | Encrypt / Decrypt errors | New videos fail packaging (retried); key requests fail | Worker retries via `failOrRequeue`; players retry key fetch |
| CloudFront or signing misconfiguration | Player 403s on segments | Playback fails | Switch `DELIVERY_DRIVER` (presigned, proxy) without redeploying the pipeline |
| Webhook receiver down | Non-2xx or timeout | Events delayed | Exponential backoff with jitter up to 1 h, 8 attempts, then `failed` and manual redeliver |
| Orchestrator Lambda errors | CloudWatch alarm, DLQ alarm | No new capacity | Existing workers keep draining; next tick retries |

## Security summary

Per-video AES-128 keys, KMS-wrapped and bound to the video id; key delivery only to a
live session for that video; signed segment URLs; peppered-HMAC API keys with explicit
scopes and no self-escalation; append-only audit by trigger; private subnets, IMDSv2 and
least-privilege IAM per component. Full detail: [security.md](security.md) and the
[threat model](threat-model.md).

## Observability

| Signal | Where | What |
| ------ | ----- | ---- |
| Logs | stdout as JSON in production (winston), CloudWatch Logs on AWS | Request id on every API line; worker logs keyed by video id |
| Metrics | `GET /metrics` (Prometheus) | `evs_api_http_request_duration_seconds`, `evs_api_key_deliveries_total`, `evs_api_playlist_requests_total`, `evs_api_playback_denials_total`, `evs_api_webhook_deliveries_total`, plus process defaults |
| Health | `GET /healthz` (liveness), `GET /readyz` (database round trip) | ALB target health uses `/readyz` |
| Alarms | [`infra/terraform/modules/observability`](../../infra/terraform/modules/observability) | API 5xx, unhealthy targets, API CPU, RDS CPU, orchestrator errors, orchestrator DLQ depth, routed to SNS |
| Audit | `GET /v1/audit-events` | Every control-plane mutation with actor and request id |
| Usage | `GET /v1/usage` | Daily transcode seconds, sessions, key deliveries, uploads |

## Key design decisions

| Decision | ADR |
| -------- | --- |
| Postgres is the work queue, writes guarded by ownership | [ADR-0001](adr/0001-postgres-as-the-queue.md) |
| Self-managed FFmpeg workers instead of a managed transcoder | [ADR-0002](adr/0002-ffmpeg-workers-over-managed-transcoding.md) |
| AES-128 HLS with KMS envelope encryption now, multi-DRM later | [ADR-0003](adr/0003-aes-128-hls-now-multi-drm-later.md) |
| Spot fleet scaled from the queue; workers terminate themselves | [ADR-0004](adr/0004-spot-fleet-and-self-terminating-workers.md) |
| Local AWS emulator, one switch to real AWS | [ADR-0005](adr/0005-local-aws-emulation.md) |
| One deployment serves one organization | [ADR-0006](adr/0006-single-tenant-deployments.md) |
