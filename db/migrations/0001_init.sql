-- ─────────────────────────────────────────────────────────────────────────────
-- 0001_init.sql: core media pipeline schema
--
-- A deployment of Euron Video System serves exactly one organization (see
-- docs/architecture/adr/0006-single-tenant-deployments.md), so no table carries
-- a tenant column. Isolation between organizations is a deployment boundary:
-- separate database, buckets, KMS key and Terraform state.
--
-- Applied by `pnpm db:migrate`, which records each file in schema_migrations and
-- runs it inside a transaction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE video_status          AS ENUM ('uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled');
-- Only meaningful while status = 'processing'.
CREATE TYPE video_stage           AS ENUM ('transcoding', 'packaging', 'uploading_output');
-- 'drm_cbcs' is reserved for the multi-DRM roadmap (Widevine / FairPlay / PlayReady).
CREATE TYPE protection_mode       AS ENUM ('none', 'aes_128', 'drm_cbcs');
CREATE TYPE watermark_mode        AS ENUM ('none', 'dynamic_overlay', 'forensic_ab');
CREATE TYPE orientation           AS ENUM ('landscape', 'portrait', 'square');
CREATE TYPE key_wrap_scheme       AS ENUM ('kms', 'local_aes');
CREATE TYPE video_artifact_status AS ENUM ('pending', 'processing', 'ready', 'failed', 'skipped');
CREATE TYPE job_kind              AS ENUM ('CAPTIONS', 'DOWNLOAD');
CREATE TYPE job_status            AS ENUM ('queued', 'processing', 'done', 'failed', 'cancelled');

-- ─── Playback policies ───────────────────────────────────────────────────────
-- Reusable rules a video's playback tokens are minted under. A video with no
-- policy uses the row flagged is_default.
CREATE TABLE playback_policies (
  id                      text PRIMARY KEY,
  name                    text NOT NULL UNIQUE,
  is_default              boolean NOT NULL DEFAULT false,
  token_ttl_seconds       integer NOT NULL DEFAULT 300 CHECK (token_ttl_seconds BETWEEN 10 AND 86400),
  max_token_ttl_seconds   integer NOT NULL DEFAULT 3600 CHECK (max_token_ttl_seconds BETWEEN 10 AND 86400),
  -- Empty array = any origin. Entries are exact origins: "https://app.example.com".
  allowed_origins         text[] NOT NULL DEFAULT '{}',
  -- 0 = unlimited concurrent sessions per viewer.
  max_concurrent_sessions integer NOT NULL DEFAULT 0 CHECK (max_concurrent_sessions >= 0),
  watermark_required      boolean NOT NULL DEFAULT true,
  allow_download          boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
-- Exactly one default policy.
CREATE UNIQUE INDEX playback_policies_one_default ON playback_policies (is_default) WHERE is_default;

INSERT INTO playback_policies (id, name, is_default)
VALUES ('01JDEFAULTPOLICY0000000000', 'default', true);

-- ─── Videos (also the primary work queue) ────────────────────────────────────
CREATE TABLE videos (
  id                 text PRIMARY KEY,                 -- ULID, also the storage key segment
  title              text NOT NULL,
  external_ref       text,                             -- caller's own id for this asset
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,

  status             video_status NOT NULL DEFAULT 'uploading',
  stage              video_stage,
  progress           smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),

  -- storage
  source_key         text,                             -- uploads bucket: uploads/{id}/original.{ext}
  source_bytes       bigint,
  output_prefix      text,                             -- media bucket:   media/{id}
  output_bytes       bigint,                           -- packaged tree footprint, summed at upload
  orientation        orientation,
  duration_seconds   integer,

  -- protection + features
  protection         protection_mode NOT NULL DEFAULT 'aes_128',
  watermark          watermark_mode  NOT NULL DEFAULT 'dynamic_overlay',
  playback_policy_id text REFERENCES playback_policies (id) ON DELETE SET NULL,
  captions_langs     text[] NOT NULL DEFAULT '{}',
  captions_status    video_artifact_status NOT NULL DEFAULT 'pending',
  mp4_status         video_artifact_status NOT NULL DEFAULT 'pending',
  -- per-video pipeline knobs (ladder override, captions toggle, ...)
  pipeline_config    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- queue / claim mechanics (see packages/core/src/queue)
  locked_by          text,
  locked_at          timestamptz,                      -- absolute-timeout anchor (6h)
  heartbeat_at       timestamptz,                      -- stale-timeout anchor (10m)
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 3,

  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  deleted_at         timestamptz
);

-- The claim only scans 'uploaded' and the reaper only scans 'processing', so
-- these partial indexes stay tiny no matter how large the catalog grows.
CREATE INDEX videos_uploaded_idx   ON videos (created_at)   WHERE status = 'uploaded';
CREATE INDEX videos_processing_idx ON videos (heartbeat_at) WHERE status = 'processing';
CREATE INDEX videos_created_idx    ON videos (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX videos_external_ref_idx ON videos (external_ref) WHERE external_ref IS NOT NULL;

-- ─── Renditions written by the worker after packaging ────────────────────────
CREATE TABLE video_renditions (
  id            text PRIMARY KEY,
  video_id      text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  label         text NOT NULL,                         -- "1080", "720", ...
  width         integer NOT NULL,
  height        integer NOT NULL,
  bitrate_kbps  integer NOT NULL,
  codec         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, label)
);

-- ─── Per-video AES-128 content keys (envelope-encrypted at rest) ─────────────
CREATE TABLE content_keys (
  id            text PRIMARY KEY,
  video_id      text NOT NULL UNIQUE REFERENCES videos (id) ON DELETE CASCADE,
  kid_hex       char(32) NOT NULL,                     -- 16-byte key id
  wrapped_key   text NOT NULL,                         -- base64 of the wrapped 16-byte key
  wrap_scheme   key_wrap_scheme NOT NULL,
  kms_key_ref   text,                                  -- KMS key the wrap used (null for local_aes)
  key_version   integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz
);

-- ─── Decoupled post-processing queue (one row per artifact) ──────────────────
CREATE TABLE jobs (
  id            text PRIMARY KEY,
  video_id      text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  kind          job_kind NOT NULL,
  status        job_status NOT NULL DEFAULT 'queued',
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  locked_by     text,
  locked_at     timestamptz,
  heartbeat_at  timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queued_idx   ON jobs (created_at)   WHERE status = 'queued';
CREATE INDEX jobs_video_id_idx ON jobs (video_id);
