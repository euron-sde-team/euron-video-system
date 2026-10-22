/**
 * Kysely table types for db/migrations. Regenerate from a migrated database with
 * `pnpm db:codegen` (kysely-codegen); keep this file in sync with every migration.
 */
import type { ColumnType } from "kysely";

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

/** pg returns BIGINT as string; parse with toNumber() before arithmetic. */
export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
export type Json = ColumnType<unknown, string, string>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type VideoStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed" | "cancelled";
export type VideoStage = "transcoding" | "packaging" | "uploading_output";
export type ProtectionMode = "none" | "aes_128" | "drm_cbcs";
export type WatermarkMode = "none" | "dynamic_overlay" | "forensic_ab";
export type Orientation = "landscape" | "portrait" | "square";
export type KeyWrapScheme = "kms" | "local_aes";
export type VideoArtifactStatus = "pending" | "processing" | "ready" | "failed" | "skipped";
export type JobKind = "CAPTIONS" | "DOWNLOAD";
export type JobStatus = "queued" | "processing" | "done" | "failed" | "cancelled";
export type WebhookDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";
export type ActorType = "api_key" | "system" | "cli";

export interface PlaybackPoliciesTable {
  id: string;
  name: string;
  is_default: Generated<boolean>;
  token_ttl_seconds: Generated<number>;
  max_token_ttl_seconds: Generated<number>;
  allowed_origins: Generated<string[]>;
  max_concurrent_sessions: Generated<number>;
  watermark_required: Generated<boolean>;
  allow_download: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface VideosTable {
  id: string;
  title: string;
  external_ref: string | null;
  metadata: Generated<Json>;
  status: Generated<VideoStatus>;
  stage: VideoStage | null;
  progress: Generated<number>;
  source_key: string | null;
  source_bytes: Int8 | null;
  output_prefix: string | null;
  output_bytes: Int8 | null;
  orientation: Orientation | null;
  duration_seconds: number | null;
  protection: Generated<ProtectionMode>;
  watermark: Generated<WatermarkMode>;
  playback_policy_id: string | null;
  captions_langs: Generated<string[]>;
  captions_status: Generated<VideoArtifactStatus>;
  mp4_status: Generated<VideoArtifactStatus>;
  pipeline_config: Generated<Json>;
  locked_by: string | null;
  locked_at: Timestamp | null;
  heartbeat_at: Timestamp | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  ready_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface VideoRenditionsTable {
  id: string;
  video_id: string;
  label: string;
  width: number;
  height: number;
  bitrate_kbps: number;
  codec: string;
  created_at: Generated<Timestamp>;
}

export interface ContentKeysTable {
  id: string;
  video_id: string;
  kid_hex: string;
  wrapped_key: string;
  wrap_scheme: KeyWrapScheme;
  kms_key_ref: string | null;
  key_version: Generated<number>;
  created_at: Generated<Timestamp>;
  rotated_at: Timestamp | null;
}

export interface JobsTable {
  id: string;
  video_id: string;
  kind: JobKind;
  status: Generated<JobStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_by: string | null;
  locked_at: Timestamp | null;
  heartbeat_at: Timestamp | null;
  error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ApiKeysTable {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  created_by: string | null;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface PlaybackSessionsTable {
  id: string;
  video_id: string;
  viewer_id: string;
  policy_id: string | null;
  origin: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  issued_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
}

export interface WebhookEndpointsTable {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  secret_ciphertext: string;
  enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WebhookDeliveriesTable {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: Json;
  status: Generated<WebhookDeliveryStatus>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  next_attempt_at: Generated<Timestamp>;
  locked_by: string | null;
  locked_at: Timestamp | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface AuditEventsTable {
  id: string;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_hash: string | null;
  request_id: string | null;
  metadata: Generated<Json>;
  created_at: Generated<Timestamp>;
}

export interface UsageDailyTable {
  day: ColumnType<Date, Date | string, Date | string>;
  videos_created: Generated<number>;
  transcode_seconds: Generated<Int8>;
  playback_sessions: Generated<number>;
  key_deliveries: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface DB {
  playback_policies: PlaybackPoliciesTable;
  videos: VideosTable;
  video_renditions: VideoRenditionsTable;
  content_keys: ContentKeysTable;
  jobs: JobsTable;
  api_keys: ApiKeysTable;
  playback_sessions: PlaybackSessionsTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  audit_events: AuditEventsTable;
  usage_daily: UsageDailyTable;
}
