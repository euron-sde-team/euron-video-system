# Threat Model (STRIDE)

Scope: one deployment as provisioned by `infra/terraform/envs/aws-prod`, with
`DELIVERY_DRIVER=cloudfront-signed` and KMS key wrapping. The assets, in order
of sensitivity:

1. **Content keys**: anyone holding a video's key and its segments can decrypt that video.
2. **Source and processed MP4s**: unencrypted by design (the uploader's own master copy).
3. **API keys and deployment secrets**: these allow control-plane takeover.
4. **Playback sessions**: these allow watching as someone else.
5. **The audit log**: tampering with it hides misuse.

Each threat below is listed with its mitigation and the residual risk.

## Spoofing

| Threat | Mitigation | Residual |
| ------ | ---------- | -------- |
| Forged playback token | HS256 with 32+ char keyring secrets; `aud`, `iss`, `exp` checked; the `jti` must be a live session row | A leaked signing key forges tokens until it is rotated (keyring procedure in security.md) |
| Stolen playback token replayed elsewhere | Short TTL (300 s default), origin allowlist, per-viewer session cap, instant revocation | A replay from an allowed origin inside the TTL window works. Keep TTLs short. |
| Stolen API key | Peppered HMAC at rest, scopes, expiry, per-key revocation, `last_used_at`, audit trail | The holder acts with that key's scopes until it is revoked |
| Spoofed webhook to a receiver | HMAC signature with timestamp, stable event id for deduplication | Receivers must verify signatures. Documented with a code sample. |

## Tampering

| Threat | Mitigation | Residual |
| ------ | ---------- | -------- |
| Swap a wrapped key between videos | KMS encryption context / GCM AAD bound to `videoId` | None known |
| Modify segments in storage | Bucket writable only by worker role; CloudFront OAC is read-only | A compromised worker role can overwrite media |
| Upload a non-video or oversized file | Presigned POST conditions (size range, `video/*`); ffprobe validates before encoding | A malicious-but-valid media file reaches FFmpeg (see Elevation) |
| Alter the audit log | Database triggers reject UPDATE, DELETE and TRUNCATE | A superuser can disable triggers. Ship logs to an external sink for WORM retention. |
| Path traversal in playlist routes | Rung labels must match `^[0-9]{2,4}$`; proxy paths are allowlisted under `media/{id}/` | None known |

## Repudiation

| Threat | Mitigation |
| ------ | ---------- |
| "I didn't revoke that key / delete that video" | Every mutation is audited with actor id, request id and IP hash |
| "That viewer never watched it" | `playback_sessions` rows (viewer, origin, UA, issue time), key-delivery metrics, and CloudTrail KMS `Decrypt` events per video |

## Information disclosure

| Threat | Mitigation | Residual |
| ------ | ---------- | -------- |
| Authorized viewer extracts the content key | n/a for clear-key schemes; watermark deters recording | **Accepted.** Hardware DRM is on the roadmap (ADR-0003). |
| Bucket made public by mistake | Block Public Access at the bucket level, OAC, TLS-only policy, checkov policy checks (workflow provided) | An account-level override by an admin |
| Database dump | Content keys wrapped by KMS, API keys peppered, webhook secrets sealed, IPs hashed | Video titles and metadata are in plaintext |
| Error messages leak internals | Production errors return a code and request id; stack traces only in logs | None known |
| Webhook used for SSRF into the VPC or metadata service | Private, loopback, link-local and metadata IPs refused at delivery time in production | DNS rebinding between check and connect. Low impact because the response body is not returned. |

## Denial of service

| Threat | Mitigation | Residual |
| ------ | ---------- | -------- |
| Upload flood | `MAX_IN_FLIGHT` backpressure, API key rate limits, presigned size cap | Bounded by the cap |
| Playlist and key hammering | Per-IP rate limit on `/v1/play`, revocation cache, cheap rewrite (no DB writes on the hot path) | Volumetric attacks need AWS WAF / Shield in front of the ALB (supported, not enabled by default) |
| Poison-pill video crashing workers | `max_attempts` then terminal `failed`; a heartbeat timeout reaps hung encodes | Each attempt costs up to the absolute timeout (6 h) of compute |
| Spot capacity exhaustion | Multi-AZ x instance-type ladder; optional on-demand fallback | Queue latency grows until capacity returns |

## Elevation of privilege

| Threat | Mitigation | Residual |
| ------ | ---------- | -------- |
| Malicious media exploits FFmpeg | Workers are disposable, have no inbound network, IMDSv2 hop limit 1, a narrow IAM role, and run as non-root | A worker compromise grants that role's S3 and KMS access (wrap only, no decrypt) |
| Scope escalation via key creation | Creating keys requires `keys:manage`; a key cannot grant scopes it lacks unless it holds `*` | Holders of `*` are equivalent to root. Store them like root credentials. |
| Container escape to host | Fargate isolation for the API, non-root images | Standard container risk |
