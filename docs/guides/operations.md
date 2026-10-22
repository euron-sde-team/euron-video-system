# Operations runbook

Day-2 operation of a deployed stack: what to watch, where the logs are, how to scale, how
to rotate secrets, and what to do when something breaks. Commands assume the `aws-prod`
environment. Substitute your own `name_prefix` for `evs-prod`.

- [Health and readiness](#health-and-readiness)
- [Metrics and alarms](#metrics-and-alarms)
- [Logs](#logs)
- [Scaling knobs](#scaling-knobs)
- [Managing videos](#managing-videos)
- [Access: API keys and playback sessions](#access-api-keys-and-playback-sessions)
- [Rotating secrets](#rotating-secrets)
- [Backups and restore](#backups-and-restore)
- [Incident checklist](#incident-checklist)

## Health and readiness

| Endpoint | Meaning | Used by |
| --- | --- | --- |
| `GET /healthz` | The process is up | Container health check |
| `GET /readyz` | The process can reach Postgres (and reports latency) | ALB target group |
| `GET /metrics` | Prometheus exposition | Your scraper |

```bash
curl -s https://api.video.example.com/readyz
# {"status":"ready","checks":{"database":{"ok":true,"latencyMs":2}}}
```

> [!TIP]
> `/metrics` is unauthenticated. If the ALB is internet-facing, restrict that path at the
> ALB or a WAF rule to your monitoring network.

## Metrics and alarms

**Application metrics** (Prometheus, from [`apps/api/src/metrics.ts`](../../apps/api/src/metrics.ts)):

| Metric | Watch for |
| --- | --- |
| `evs_api_http_request_duration_seconds` | Latency by route and status. Rising p99 on `/v1/play/*` means viewers buffer. |
| `evs_api_key_deliveries_total` | Key requests. Roughly one per player start. |
| `evs_api_playlist_requests_total` | Playlist traffic |
| `evs_api_playback_denials_total` | Rejected playback (expired, revoked, origin). A spike after a deploy usually means a token or keyring misconfiguration. |
| `evs_api_webhook_deliveries_total` | Webhook outcomes. A rising `failed` count means a receiver is down. |

**CloudWatch alarms** (from [`modules/observability`](../../infra/terraform/modules/observability)),
all publishing to the `alarm_email` SNS topic:

| Alarm | Fires when | First check |
| --- | --- | --- |
| `<prefix>-api-5xx` | The ALB returns too many 5xx | API logs by request id. Recent deploy? |
| `<prefix>-api-unhealthy-targets` | Any target fails `/readyz` | Database reachability, task crash loops |
| `<prefix>-api-cpu-high` | API CPU stays high | Autoscaling at max? Playback traffic spike? |
| `<prefix>-db-cpu-high` | RDS CPU stays high | Performance Insights top SQL |
| `<prefix>-orchestrator-errors` | The Lambda tick errors | Orchestrator logs: DB connectivity or EC2 permissions |
| `<prefix>-orchestrator-dlq` | A tick failed past retries | Same as above |

**Queue health** has no built-in metric yet. Query it directly:

```sql
SELECT status, count(*) FROM videos GROUP BY status;
SELECT kind, status, count(*) FROM jobs GROUP BY kind, status;
-- Oldest work still waiting:
SELECT id, created_at FROM videos WHERE status = 'uploaded' ORDER BY created_at LIMIT 5;
```

`GET /v1/stats` returns the same counters for dashboards.

## Logs

| Component | CloudWatch log group |
| --- | --- |
| API (and one-off `migrate` tasks, stream prefix `migrate`) | `/evs/<prefix>/api` |
| Workers (one stream per instance id) | `/evs/<prefix>/worker` |
| Orchestrator | `/aws/lambda/<prefix>-orchestrator` |
| VPC flow logs | `/evs/<prefix>/vpc-flow` |

API logs are one JSON object per line, with `requestId` matching the `X-Request-Id`
response header. Every error response carries that id, so a customer report maps to one
log line. Logs Insights examples:

```text
fields @timestamp, level, message, requestId
| filter level = "error"
| sort @timestamp desc | limit 50
```

```text
fields @timestamp, @message
| filter @message like /01J…videoid…/
| sort @timestamp asc
```

## Scaling knobs

| Knob | Where | Effect |
| --- | --- | --- |
| `max_workers` | tfvars | Ceiling on concurrent transcode workers |
| `enable_jobs_pool` | tfvars | Captions and MP4 on a separate, smaller pool, so they never compete with transcodes |
| `worker_instance_types` / `jobs_instance_types` | `orchestrator` module | Preference ladder, all arm64 to match the AMI |
| `jobs_max_workers` | `orchestrator` module | Ceiling for the jobs pool |
| `ondemand_fallback` | `orchestrator` module | Launch On-Demand when no Spot pool has capacity (off by default) |
| `schedule_expression` | `orchestrator` module | Tick rate (default `rate(1 minute)`) |
| `extra_environment` → `IDLE_GRACE_MS` | `worker-fleet` module | How long an idle worker waits before terminating (default 2 minutes) |
| `extra_environment` → `LADDER_PRESET`, `LADDER_CRF` | `worker-fleet` module | Encode speed and quality trade-off |
| `desired_count` / `min_count` / `max_count` | `api-service` module | API task count and autoscaling range |
| `instance_class` | `database` module | Database size |

Module-level settings are arguments of the module calls in `envs/<env>/main.tf`. Every
variable is listed in [configuration.md](configuration.md).

## Managing videos

| Task | API | Notes |
| --- | --- | --- |
| Retry a failed video | `POST /v1/videos/{id}/retry` | Resets attempts. A new transcode generates a **new** content key. |
| Cancel | `POST /v1/videos/{id}/cancel` | Works mid-transcode: the worker's next heartbeat fails and FFmpeg is killed |
| Delete | `DELETE /v1/videos/{id}` | Removes stored objects, keys and sessions. Viewers lose access immediately. |
| Rename / re-tag | `PATCH /v1/videos/{id}` | Title, metadata, `externalRef`, playback policy |
| Re-download the MP4 | `GET /v1/videos/{id}/download` | Short-lived presigned URL |

The same actions exist in the console's video row menu. Every action is recorded in the
audit log (`GET /v1/audit-events?resourceId=<id>`).

## Access: API keys and playback sessions

- **Revoke an API key:** `DELETE /v1/api-keys/{id}` from another key, or in the console
  under **API keys**. Running API instances stop accepting it within about 30 seconds (key
  lookups are cached briefly).
- **Revoke a viewer's access:** `DELETE /v1/playback-sessions/{id}`. Playlist and key
  requests fail within a few seconds. To cut off a viewer everywhere, list their sessions
  with `GET /v1/playback-sessions?viewerId=<id>&active=true` and revoke each one.
- **Audit:** `GET /v1/audit-events?action=api_key.revoke` and similar. The table is
  append-only at the database level.

## Rotating secrets

| Secret | Rotation | Impact |
| --- | --- | --- |
| **Database password** | **Automatic.** RDS rotates its managed password. | None. The API, workers and orchestrator read the password from the secret for every new connection (60-second cache), so no restart is needed. |
| **Playback signing keys** | Keyring procedure (below) | None if followed. Skipping steps logs out every active viewer. |
| **API key pepper** | Replace, then reissue every key | **Every API key stops working.** Treat it as an emergency-only action. |
| **CloudFront key pair** | Replace, then redeploy the API | Signed segment URLs issued before the switch fail until players re-mint, usually within one token lifetime |
| **Data encryption key** | Only with care | Seals webhook secrets (and content keys when KMS is off). Rotating it makes existing sealed values unreadable. |
| **KMS key material** | Automatic, yearly | None. KMS keeps old key material for decryption. |

**Playback keyring, zero downtime.** `PLAYBACK_SIGNING_KEYS` is a keyring such as
`k1=<secret>`. Tokens are signed with `PLAYBACK_ACTIVE_KID` and verified against any key in
the ring.

1. Add a new key next to the old one: `k1=<old>,k2=<new>`. Keep `PLAYBACK_ACTIVE_KID=k1`.
   Deploy, so every task can *verify* `k2`.
2. Switch `PLAYBACK_ACTIVE_KID=k2`. Deploy. New tokens are signed with `k2`.
3. Wait at least the longest `maxTokenTtlSeconds` across your playback policies.
4. Remove `k1`. Deploy.

> [!IMPORTANT]
> These values live in the `<prefix>/api` secret. The
> [`secrets`](../../infra/terraform/modules/secrets) module **seeds** it once and then ignores
> its value (`lifecycle { ignore_changes = [secret_string] }`), so operators own rotation and
> `terraform apply` never reverts it. Edit the JSON in Secrets Manager:
>
> ```bash
> aws secretsmanager get-secret-value --secret-id <prefix>/api --query SecretString --output text > api.json
> # edit PLAYBACK_SIGNING_KEYS / PLAYBACK_ACTIVE_KID in api.json, then:
> aws secretsmanager put-secret-value --secret-id <prefix>/api --secret-string file://api.json && shred -u api.json
> ```
>
> ECS injects secrets at task start, so each "deploy" above means a new deployment of the
> service: `aws ecs update-service --cluster <cluster> --service api --force-new-deployment`.

**CloudFront key pair.** Generate a new key pair in Terraform (this updates the public key
in the CloudFront key group), copy the new private key into the `<prefix>/api` secret, then
redeploy the API. Until the redeploy, the old key keeps signing and its public key is gone
from the key group, so do the three steps back to back:

```bash
terraform apply -replace=module.secrets.tls_private_key.cloudfront
terraform output -raw cloudfront_private_key_pem > cf.pem   # sensitive output
# set CLOUDFRONT_PRIVATE_KEY in <prefix>/api to the contents of cf.pem (as above), then:
shred -u cf.pem
aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" --service api --force-new-deployment
```

## Backups and restore

- **RDS:** automated backups (7 days by default, `backup_retention_days` in the `database`
  module), a final snapshot on destroy in prod, Multi-AZ failover. Restore with a
  point-in-time restore to a new instance, then point the stack at it.
- **S3:** the media bucket can always be regenerated from sources while uploads are
  retained. Raw uploads expire by lifecycle rule, so restoring a long-deleted video means
  re-uploading it.
- **KMS:** never delete the key while you need the videos. Deleting it makes every wrapped
  content key, and therefore every encrypted video, permanently unreadable. This is
  deliberate crypto-shredding for offboarding.
- **Secrets:** deleted secrets enter a 30-day recovery window in prod.

## Incident checklist

1. **Scope it.** Are viewers failing to play (delivery), or are new videos not becoming
   ready (pipeline)? Check `GET /v1/stats` and the alarms.
2. **Recent change?** Compare the time with the last deploy, image tag, AMI or secret
   rotation. Roll back first, investigate second (see [deploy-aws.md](deploy-aws.md#upgrades-and-rollbacks)).
3. **Delivery path:** `evs_api_playback_denials_total` by reason, API 4xx and 5xx, and
   whether `/v1/play/*/key` succeeds for a fresh session.
4. **Pipeline path:** queue counts, orchestrator logs (launch decisions, EC2 errors), worker
   logs (claims, FFmpeg errors), Spot capacity in the EC2 console.
5. **Data path:** RDS CPU, connections, storage. Secrets Manager reachability (VPC endpoint).
6. **Communicate** with the request ids from client error responses. They map to single log lines.
7. **Afterwards:** add the failure to [troubleshooting.md](troubleshooting.md), and an alarm
   if one would have caught it.
