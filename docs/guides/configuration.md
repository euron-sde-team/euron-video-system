# Configuration reference

Every environment variable Euron Video System reads, grouped by the process that reads it.
The authoritative source is the validated schema in
[`packages/core/src/config/index.ts`](../../packages/core/src/config/index.ts). This page
is written from it.

- [How configuration is validated](#how-configuration-is-validated)
- [Shared by every service](#shared-by-every-service)
- [API](#api)
- [Worker](#worker)
- [Orchestrator](#orchestrator)
- [Console, receiver, tests](#console-receiver-tests)
- [Local stack (Docker Compose)](#local-stack-docker-compose)
- [Demo and e2e scripts](#demo-and-e2e-scripts)
- [Generating secrets](#generating-secrets)

> [!TIP]
> Running locally with `make up`? You don't need to set anything. `make env` generates
> `deploy/compose/.env` with random local-only secrets, and the compose files supply the
> rest. This page matters when you deploy or run a service by hand.

## How configuration is validated

```mermaid
flowchart LR
  env["process.env"] --> zod["Zod schema<br/>per service"]
  zod -->|"all issues collected"| fail["ConfigError<br/>lists every problem<br/>process exits"]
  zod --> cross["cross-field rules"]
  cross -->|"violation"| fail
  cross --> prod{"NODE_ENV=production?"}
  prod -->|"placeholder secret"| fail
  prod --> ok["typed, memoized config"]
```

Each process parses only the slice it needs, once, at boot.

- **Fail fast, report everything.** A misconfigured service refuses to start, and the error
  lists every missing or malformed variable at once, not just the first.
- **No silent infrastructure defaults.** Anything that names infrastructure (buckets,
  endpoints, keys) is required. Defaults exist only where a value is safe everywhere
  (timeouts, encoder tuning).
- **Placeholder secrets are rejected in production.** With `NODE_ENV=production`, values
  matching `change-me`, `example`, `placeholder` or all-`x` are refused for
  `DATA_ENCRYPTION_KEY`, `API_KEY_PEPPER` and `PLAYBACK_SIGNING_KEYS`.
- **Secrets must be real.** Secrets are at least 32 characters.

**Cross-field rules**

| Rule | Error when violated |
| --- | --- |
| Either `DATABASE_URL`, or `DATABASE_SECRET_ARN` with `DB_HOST`, `DB_NAME` and `DB_USER` | `DATABASE_URL: required unless DATABASE_SECRET_ARN …` |
| `DB_SSL=verify-full` needs `DB_SSL_CA_FILE` | `DB_SSL_CA_FILE: required for DB_SSL=verify-full` |
| `PLAYBACK_ACTIVE_KID` must name a key in `PLAYBACK_SIGNING_KEYS` | `PLAYBACK_ACTIVE_KID: must name a key present in …` |
| `DELIVERY_DRIVER=cloudfront-signed` needs `MEDIA_PUBLIC_BASE`, `CLOUDFRONT_KEY_PAIR_ID` and `CLOUDFRONT_PRIVATE_KEY` | one issue per missing variable |
| `DELIVERY_DRIVER=public` needs `MEDIA_PUBLIC_BASE` | `MEDIA_PUBLIC_BASE: required for public delivery` |
| `LAUNCHER=ec2-spot` needs `LAUNCH_TEMPLATE_NAME` and `WORKER_SUBNET_IDS` | one issue per missing variable |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` is refused when `EVS_CLOUD=aws` | `not allowed when EVS_CLOUD=aws (local demos only)` |

Booleans accept `true`/`false`/`1`/`0`. Lists are comma-separated (`a,b,c`).

## Shared by every service

Read by the API, the worker and the migration runner. The orchestrator Lambda reads only the
database settings from this table.

| Variable | Required | Default | Description | Example |
| --- | :-: | --- | --- | --- |
| `NODE_ENV` | | `development` | `development`, `test` or `production`. Production enables JSON logs, placeholder rejection and hides error messages from clients. | `production` |
| `LOG_LEVEL` | | `info` in production, else `debug` | `error`, `warn`, `info` or `debug` | `info` |
| `EVS_CLOUD` | | `aws` | `floci` or `aws`. Log context, plus the safety check on `WEBHOOK_ALLOW_PRIVATE_TARGETS`. | `aws` |
| `EVS_SERVICE` | | `evs` | Service name stamped on every log line and the Postgres `application_name` | `api` |
| `DATABASE_URL` | one of | | Static Postgres URL. Takes precedence over the secret-based settings. | `postgres://evs:evs@localhost:5432/evs` |
| `DATABASE_SECRET_ARN` | one of | | AWS: read the password from this RDS-managed secret for **every new connection** (cached 60 s), so password rotation needs no restart | `arn:aws:secretsmanager:us-east-1:123456789012:secret:evs-db-example` |
| `DB_HOST` | with secret | | Database host for the secret-based mode | `evs-prod.example.us-east-1.rds.amazonaws.com` |
| `DB_PORT` | | `5432` | Database port | `5432` |
| `DB_NAME` | with secret | | Database name | `evs` |
| `DB_USER` | with secret | | Database user. The username is stable across RDS password rotation. | `evs_admin` |
| `DB_SSL` | | `require` | `disable`, `require` (encrypt) or `verify-full` (encrypt and verify against `DB_SSL_CA_FILE`) | `require` |
| `DB_SSL_CA_FILE` | for `verify-full` | | Path to the CA bundle (e.g. the RDS global bundle) | `/etc/ssl/rds-global-bundle.pem` |
| `PG_POOL_MAX` | | `8` in production, else `10` | Pool size per process. Size RDS `max_connections` for API tasks × cluster workers × this, plus workers. | `8` |
| `PG_POOL_MIN` | | `0` | Minimum idle connections | `0` |
| `PG_CONNECTION_TIMEOUT_MS` | | `10000` | Connect timeout | `10000` |
| `PG_IDLE_TIMEOUT_MS` | | `10000` | Idle client eviction | `10000` |
| `PG_STATEMENT_TIMEOUT_MS` | | `30000` | Server-side statement timeout | `30000` |
| `AWS_REGION` | | `us-east-1` | Region for S3, KMS and Secrets Manager clients | `eu-west-1` |
| `AWS_ENDPOINT_URL` | | | Standard AWS SDK override. Point it at the emulator locally, and leave it unset on AWS. | `http://floci:4566` |
| `S3_FORCE_PATH_STYLE` | | `false` | Path-style S3 addressing (emulators, MinIO) | `true` |
| `S3_PUBLIC_ENDPOINT` | | | Browser-reachable S3 endpoint used **only for presigning**, since SigV4 signs the host | `http://localhost:4566` |
| `UPLOADS_BUCKET` | ✅ | | Raw uploads (`uploads/{id}/original.{ext}`) | `evs-prod-uploads` |
| `MEDIA_BUCKET` | ✅ | | Encrypted HLS, posters, sprites (`media/{id}/…`) | `evs-prod-media` |
| `DOWNLOADS_BUCKET` | ✅ | | Processed MP4s (`downloads/{id}.mp4`) | `evs-prod-downloads` |
| `KMS_KEY_ID` | | unset (local wrap) | KMS key id, ARN or alias that wraps content keys. **Always set it in production.** | `alias/evs-prod` |
| `DATA_ENCRYPTION_KEY` | ✅ | | 32+ chars. HKDF-derived sub-keys: the local content-key wrap (when KMS is unset) and sealing webhook secrets. | `$(openssl rand -hex 32)` |

AWS credentials are never configured here. Every client uses the default provider chain
(environment, profile, ECS task role, EC2 instance role).

## API

| Variable | Required | Default | Description | Example |
| --- | :-: | --- | --- | --- |
| `PORT` | | `8080` | Listen port | `8080` |
| `CLUSTER_WORKERS` | | `1` | Node cluster workers. `0` means one per CPU. | `0` |
| `PUBLIC_API_BASE` | ✅ | | Public URL of this API, used to build tokenized key and playlist URLs | `https://api.video.example.com` |
| `CORS_ALLOWED_ORIGINS` | | empty | Exact origins allowed to call management routes from a browser (the console) | `https://console.video.example.com` |
| `TRUST_PROXY_HOPS` | | `1` | Reverse proxies in front of the API (ALB = 1). Drives client-IP detection for rate limits. | `1` |
| `API_KEY_PEPPER` | ✅ | | 32+ chars. HMAC pepper for API key hashes. **Rotating it invalidates every key.** | `$(openssl rand -hex 32)` |
| `PLAYBACK_SIGNING_KEYS` | ✅ | | Token keyring `kid=secret,kid2=secret2`, each secret 32+ chars | `k2026a=…,k2026b=…` |
| `PLAYBACK_ACTIVE_KID` | ✅ | | Kid used to sign new tokens. Verification accepts any kid in the ring. | `k2026b` |
| `PLAYBACK_TOKEN_ISSUER` | | `evs` | JWT `iss` claim | `evs` |
| `DELIVERY_DRIVER` | | `presigned` | `cloudfront-signed`, `presigned`, `proxy` or `public` (testing only) | `cloudfront-signed` |
| `MEDIA_PUBLIC_BASE` | for CloudFront / public | | Public base URL of the media bucket | `https://media.video.example.com` |
| `CLOUDFRONT_KEY_PAIR_ID` | for CloudFront | | CloudFront public key id | `K2EXAMPLE123` |
| `CLOUDFRONT_PRIVATE_KEY` | for CloudFront | | PEM private key. `\n` escapes are accepted. | PEM text, newlines written as `\n` |
| `MAX_UPLOAD_BYTES` | | `21474836480` (20 GiB) | Upper bound enforced by the presigned POST | `5368709120` |
| `MAX_IN_FLIGHT` | | `50` | Backpressure: maximum videos not yet ready/failed/cancelled | `200` |
| `RATE_LIMIT_PER_MINUTE` | | `600` | Per API key, management routes. Counted per process. | `1200` |
| `PLAYBACK_RATE_LIMIT_PER_MINUTE` | | `3000` | Per client IP, `/v1/play/*`. Counted per process. | `6000` |
| `WEBHOOK_DISPATCH_ENABLED` | | `true` | Run the outbox dispatcher in this process | `true` |
| `WEBHOOK_TIMEOUT_MS` | | `10000` | Per-delivery HTTP timeout | `5000` |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | | `false` | **Local demos only.** Lets webhooks reach private or in-network addresses (and plain `http`) while `NODE_ENV=production`. Refused when `EVS_CLOUD=aws`. | `false` |
| `OPENAPI_PATH` | | auto-detected | Location of `openapi.yaml` served at `/v1/openapi.yaml` and `/docs` | `/app/openapi.yaml` |

## Worker

| Variable | Required | Default | Description | Example |
| --- | :-: | --- | --- | --- |
| `WORKER_MODE` | | `all` | `all` (videos, then jobs), `primary` (videos only) or `jobs` (captions and MP4 only) | `primary` |
| `WORKER_ID` | | instance id or hostname | Identity written to `locked_by` | `worker-a` |
| `WORKER_PLATFORM` | | `ec2` | `ec2`: IMDSv2 identity, Spot-interruption watch, idle self-termination. `local`: none of those. | `local` |
| `IDLE_GRACE_MS` | | `120000` | Idle time before self-termination (ec2) | `300000` |
| `POLL_MS` | | `5000` | Claim poll interval when idle | `5000` |
| `HEARTBEAT_MS` | | `30000` | Heartbeat interval. The reaper treats 10 minutes of silence as dead. | `30000` |
| `WORKER_DRY_RUN_SHUTDOWN` | | `true` | Log instead of shutting the host down. Set `false` on EC2. | `false` |
| `WORK_DIR` | | `/tmp/evs` | Scratch space for sources and renditions | `/var/lib/evs/work` |
| `FFMPEG_BIN` · `FFPROBE_BIN` | | `ffmpeg` · `ffprobe` | Binaries | `/usr/local/bin/ffmpeg` |
| `WHISPER_BIN` | | `/opt/whisper.cpp/whisper-cli` | whisper.cpp CLI | |
| `WHISPER_MODEL` | | `/opt/models/ggml-small.bin` | ggml model file | `/opt/models/ggml-base.bin` |
| `CAPTIONS_ENABLED` | | `true` | Queue a captions job for videos with audio. Can also be disabled per video (`captions: false`). | `true` |
| `CAPTIONS_DEFAULT_LANG` | | `en` | Language passed to whisper | `en` |
| `LADDER_PRESET` | | `medium` | x264 preset for the streaming ladder | `veryfast` |
| `LADDER_CRF` | | `19` | Capped-CRF quality target (lower is sharper and larger) | `20` |
| `CAP_TO_SOURCE` | | `true` | Cap each rung's bitrate to the source bitrate × factor | `true` |
| `CAP_TO_SOURCE_FACTOR` | | `1.1` | Headroom over the source bitrate | `1.1` |
| `CAP_TO_SOURCE_FLOOR` | | `0.6` | Never cap a rung below this fraction of its ladder bitrate | `0.6` |
| `MIN_OUTPUT_FPS` | | `24` | Constant frame rate for near-static sources (slides) so MSE players can play them | `24` |
| `DOWNLOAD_ENABLED` | | `true` | Produce the downloadable MP4 | `true` |
| `DOWNLOAD_VIDEO_CODEC` | | `libx264` | `libx264` or `libx265` | `libx264` |
| `DOWNLOAD_CRF` · `DOWNLOAD_PRESET` | | `23` · `medium` | MP4 quality and speed | `23` · `medium` |
| `DOWNLOAD_MAXRATE_KBPS` | | `2800` | Bitrate cap for the MP4. `0` disables the cap. | `2800` |

## Orchestrator

| Variable | Required | Default | Description | Example |
| --- | :-: | --- | --- | --- |
| `LAUNCHER` | | `ec2-spot` | `ec2-spot` launches EC2 Fleet capacity. `noop` only logs decisions. | `noop` |
| `ORCHESTRATOR_INTERVAL_MS` | | `60000` | Tick interval for the local loop (the Lambda is scheduled instead) | `60000` |
| `MAX_WORKERS` | | `20` | Cap on primary workers | `40` |
| `DIVISOR` | | `1` | Queued videos per worker | `1` |
| `LAUNCH_TEMPLATE_NAME` | for ec2-spot | | Primary pool launch template | `evs-prod-worker` |
| `LAUNCH_TEMPLATE_VERSION` | | `$Latest` | Template version | `$Latest` |
| `WORKER_SUBNET_IDS` | for ec2-spot | | Subnets to fan out across, ideally one per AZ | `subnet-aaaa,subnet-bbbb` |
| `WORKER_INSTANCE_TYPES` | | `c7g.4xlarge,c7g.2xlarge,c7g.xlarge,c6g.xlarge,m7g.xlarge` | Strict preference ladder. Must match the AMI architecture. | |
| `WORKER_ROLE_TAG` | | `evs-transcoder` | Tag used to count running workers | `evs-transcoder` |
| `SPOT_ALLOCATION_STRATEGY` | | `price-capacity-optimized` | `capacity-optimized`, `price-capacity-optimized`, `lowest-price` or `diversified` | |
| `ONDEMAND_FALLBACK` | | `false` | Fall back to on-demand when no Spot pool has capacity | `true` |
| `JOBS_LAUNCH_TEMPLATE_NAME` | | | Enables a separate, smaller pool for captions and MP4 jobs | `evs-prod-jobs` |
| `JOBS_INSTANCE_TYPES` | | `c7g.xlarge,c6g.xlarge,m7g.xlarge` | Jobs pool ladder | |
| `JOBS_ROLE_TAG` | | `evs-transcoder-jobs` | Tag for the jobs pool | |
| `JOBS_MAX_WORKERS` | | `10` | Cap on jobs workers | `10` |

The orchestrator also reads the database settings (`DATABASE_URL`, or `DATABASE_SECRET_ARN`
with `DB_*`) from [Shared by every service](#shared-by-every-service). The Lambda opens one
client per invocation and never uses a pool.

## Console, receiver, tests

| Variable | Read by | Default | Description |
| --- | --- | --- | --- |
| `VITE_API_BASE` | console (build time) | `http://localhost:8080` | API base pre-filled in Settings |
| `PORT` | [webhook receiver](../../examples/webhook-receiver/server.mjs) | `9099` | Listen port |
| `WEBHOOK_SIGNING_SECRET` | webhook receiver | | The endpoint's `whsec_…` secret, shown once at creation |
| `TEST_DATABASE_URL` | integration tests | | Throwaway Postgres. The schema is dropped and recreated each run. |
| `EVS_TEST_LOGS` | tests | unset | Set to `1` to see service logs during tests |

## Local stack (Docker Compose)

Set these in your shell or `deploy/compose/.env` before `make up`. The secrets are generated
by `make env`.

| Variable | Default | Effect |
| --- | --- | --- |
| `EVS_CONSOLE_PORT` | `3000` | Host port for the console. CORS follows it automatically. |
| `EVS_API_PORT` | `8080` | Host port for the API |
| `EVS_PG_PORT` | `5432` | Host port for Postgres |
| `EVS_FLOCI_PORT` | `4566` | Host port for the AWS emulator |
| `EVS_PUBLIC_API_BASE` | `http://localhost:8080` | `PUBLIC_API_BASE` for the API, and the console's default API base |
| `EVS_CORS_ALLOWED_ORIGINS` | console origin on `EVS_CONSOLE_PORT` | Override the CORS allowlist |
| `EVS_DELIVERY_DRIVER` | `proxy` (emulator overlay) | Set `presigned` to exercise S3 presigned URLs |
| `EVS_LOG_LEVEL` | `info` | `LOG_LEVEL` for every service |
| `EVS_WORKER_REPLICAS` | `2` | Number of worker containers |
| `EVS_LADDER_PRESET` | `veryfast` | Faster local encodes |
| `EVS_CAPTIONS` | `true` | Build whisper into the image and enable captions |
| `EVS_WHISPER_MODEL` | `base` | Model baked into the local worker image (`tiny`, `base`, `small`, `medium`) |
| `EVS_WEBHOOK_SIGNING_SECRET` | empty | Secret for the bundled webhook receiver |
| `EVS_DATA_ENCRYPTION_KEY` · `EVS_API_KEY_PEPPER` · `EVS_PLAYBACK_SIGNING_KEYS` | generated | Written by `make env` |
| `EVS_PLAYBACK_ACTIVE_KID` | `k1` | Active kid of the generated keyring |

## Demo and e2e scripts

| Variable | Used by | Default | Description |
| --- | --- | --- | --- |
| `EVS_API` | demo, e2e | `http://localhost:8080` | API base |
| `EVS_API_PREFIX` | `upload.sh` | `/v1` | API version prefix |
| `EVS_API_KEY` | `upload.sh`, `seed.sh` | created on demand by `seed.sh` | Key to use |
| `EVS_CONSOLE` | `upload.sh` | `http://localhost:3000` | Console URL printed at the end |
| `EVS_VIEWER` | `upload.sh` | `demo-viewer` | `viewerId` for the demo playback session |
| `EVS_E2E_KEEP` | `e2e.sh` | `0` | `1` keeps the stack up (and revokes the e2e key) |
| `EVS_E2E_TEARDOWN` | `e2e.sh` | `1` | `0` skips `docker compose down` |
| `SAMPLE_URL` | `fetch-sample.sh` | a 10 s *Big Buck Bunny* clip | Source of the demo video |
| `SAMPLE_MODE` | `seed.sh` | empty | `--synthetic` generates an FFmpeg test pattern instead (offline) |

## Generating secrets

```bash
# DATA_ENCRYPTION_KEY and API_KEY_PEPPER: 32 random bytes as hex (64 chars)
openssl rand -hex 32

# PLAYBACK_SIGNING_KEYS: a keyring of kid=secret pairs
echo "k2026a=$(openssl rand -hex 32)"
# PLAYBACK_ACTIVE_KID=k2026a

# CloudFront signing key pair (Terraform's secrets module generates this for you)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out cf-private.pem
openssl pkey -in cf-private.pem -pubout -out cf-public.pem
```

**Rotating playback signing keys with zero downtime**

1. Add the new key to the ring: `PLAYBACK_SIGNING_KEYS=k2026a=…,k2026b=…`, and deploy.
2. Switch signing: `PLAYBACK_ACTIVE_KID=k2026b`, and deploy.
3. Wait one `max_token_ttl_seconds` (the longest-lived token signed with the old key).
4. Remove `k2026a` from the ring, and deploy.

> [!WARNING]
> `API_KEY_PEPPER` and `DATA_ENCRYPTION_KEY` are not rotatable in place. Changing the pepper
> invalidates every API key. Changing the data encryption key makes sealed webhook secrets,
> and locally wrapped content keys, unreadable. Keep them in Secrets Manager and back them up.
