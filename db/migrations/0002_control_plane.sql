-- ─────────────────────────────────────────────────────────────────────────────
-- 0002_control_plane.sql: API keys, playback sessions, webhooks, audit, usage
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivering', 'delivered', 'failed');
CREATE TYPE actor_type              AS ENUM ('api_key', 'system', 'cli');

-- ─── API keys ────────────────────────────────────────────────────────────────
-- Format: evs_<prefix>_<secret>. Only an HMAC-SHA256(pepper, full key) is
-- stored; the plaintext is shown once at creation and never again.
CREATE TABLE api_keys (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        char(8) NOT NULL UNIQUE,               -- lookup handle, safe to display
  key_hash      char(64) NOT NULL,                     -- hex HMAC-SHA256
  scopes        text[] NOT NULL,
  created_by    text,                                  -- api key id or 'cli'
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── Playback sessions: one row per minted playback token (jti) ──────────────
CREATE TABLE playback_sessions (
  id            text PRIMARY KEY,                      -- = JWT jti
  video_id      text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  viewer_id     text NOT NULL,                         -- caller-defined, opaque
  policy_id     text REFERENCES playback_policies (id) ON DELETE SET NULL,
  origin        text,
  ip_hash       char(64),                              -- keyed HMAC-SHA256 (key derived from API_KEY_PEPPER), never the raw IP
  user_agent    text,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX playback_sessions_active_idx
  ON playback_sessions (viewer_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX playback_sessions_video_idx ON playback_sessions (video_id, issued_at DESC);

-- ─── Webhooks (transactional outbox) ─────────────────────────────────────────
CREATE TABLE webhook_endpoints (
  id                text PRIMARY KEY,
  url               text NOT NULL,
  description       text,
  events            text[] NOT NULL,                   -- e.g. {video.ready, video.failed} or {*}
  secret_ciphertext text NOT NULL,                     -- signing secret, AES-256-GCM sealed
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id               text PRIMARY KEY,
  endpoint_id      text NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id         text NOT NULL,                      -- stable across retries (idempotency)
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 8,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_by        text,
  locked_at        timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- ─── Audit log (append-only) ─────────────────────────────────────────────────
CREATE TABLE audit_events (
  id            text PRIMARY KEY,                      -- ULID: sortable by time
  actor_type    actor_type NOT NULL,
  actor_id      text,
  action        text NOT NULL,                         -- e.g. video.create, api_key.revoke
  resource_type text NOT NULL,
  resource_id   text,
  ip_hash       char(64),
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx  ON audit_events (created_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);

-- The audit log is append-only at the database level, not just by convention.
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
-- Row triggers do not fire on TRUNCATE, so block it with a statement trigger too.
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- ─── Daily usage rollup ──────────────────────────────────────────────────────
CREATE TABLE usage_daily (
  day                 date PRIMARY KEY,
  videos_created      integer NOT NULL DEFAULT 0,
  transcode_seconds   bigint  NOT NULL DEFAULT 0,      -- source seconds transcoded
  playback_sessions   integer NOT NULL DEFAULT 0,
  key_deliveries      integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
