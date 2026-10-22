# Architecture Decision Records

Each ADR captures one significant decision: the context that forced it, what
we chose, and what it costs us. ADRs are immutable once accepted. To revisit
one, write a new ADR that supersedes it.

| ADR | Decision | Status |
| --- | -------- | ------ |
| [0001](0001-postgres-as-the-queue.md) | Postgres is the work queue (`FOR UPDATE SKIP LOCKED`, guarded writes) | Accepted |
| [0002](0002-ffmpeg-workers-over-managed-transcoding.md) | Self-managed FFmpeg workers instead of a managed transcoder | Accepted |
| [0003](0003-aes-128-hls-now-multi-drm-later.md) | AES-128 HLS + KMS envelope encryption now, multi-DRM later | Accepted |
| [0004](0004-spot-fleet-and-self-terminating-workers.md) | Spot fleet scaled from the queue; workers terminate themselves | Accepted |
| [0005](0005-local-aws-emulation.md) | Local AWS emulator, one switch to real AWS | Accepted |
| [0006](0006-single-tenant-deployments.md) | One deployment serves one organization | Accepted |

**Template:** Status / Date, then Context, Decision, Consequences (good and bad), and Alternatives considered.
