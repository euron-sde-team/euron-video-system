export type VideoStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed" | "cancelled";
export type VideoStage = "transcoding" | "packaging" | "uploading_output";
export type ArtifactStatus = "pending" | "processing" | "ready" | "failed" | "skipped";

export const VIDEO_STATUSES: VideoStatus[] = ["uploading", "uploaded", "processing", "ready", "failed", "cancelled"];
export const TERMINAL: VideoStatus[] = ["ready", "failed", "cancelled"];

export interface Rendition {
  label: string;
  width: number;
  height: number;
  bitrateKbps: number;
  codec: string;
}

export interface Video {
  id: string;
  title: string;
  externalRef: string | null;
  metadata: Record<string, unknown>;
  status: VideoStatus;
  stage: VideoStage | null;
  progress: number;
  orientation: "landscape" | "portrait" | "square" | null;
  durationSeconds: number | null;
  protection: string;
  watermark: string;
  playbackPolicyId: string | null;
  captions: { status: ArtifactStatus; languages: string[] };
  download: { status: ArtifactStatus };
  sourceBytes: number | null;
  outputBytes: number | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  posterUrl: string | null;
  renditions?: Rendition[];
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface CreateVideoResponse {
  video: Video;
  upload: { url: string; fields: Record<string, string>; expiresAt: string };
}

export interface Stats {
  videos: { total: number; byStatus: Partial<Record<VideoStatus, number>> };
  storage: { sourceBytes: number; outputBytes: number };
  queue: { queued: number; processing: number; jobsQueued: number; jobsProcessing: number };
  activeSessions: number;
}

export interface PlaybackSessionGrant {
  sessionId: string;
  token: string;
  expiresAt: string;
  manifestUrl: string;
  thumbnailsUrl: string | null;
  posterUrl: string | null;
  watermark: { required: boolean; text: string | null };
}

export interface PlaybackSession {
  id: string;
  videoId: string;
  viewerId: string;
  origin: string | null;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  userAgent: string | null;
}

export interface PlaybackPolicy {
  id: string;
  name: string;
  isDefault: boolean;
  tokenTtlSeconds: number;
  maxTokenTtlSeconds: number;
  allowedOrigins: string[];
  maxConcurrentSessions: number;
  watermarkRequired: boolean;
  allowDownload: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SCOPES = [
  { id: "videos:read", label: "Read videos" },
  { id: "videos:write", label: "Create, update and delete videos" },
  { id: "playback:mint", label: "Mint playback sessions" },
  { id: "policies:manage", label: "Manage playback policies" },
  { id: "webhooks:manage", label: "Manage webhooks" },
  { id: "keys:manage", label: "Manage API keys" },
  { id: "audit:read", label: "Read the audit log" },
  { id: "usage:read", label: "Read usage" },
] as const;

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface Me {
  apiKey: Pick<ApiKey, "id" | "name" | "prefix" | "scopes" | "createdAt" | "expiresAt">;
}

export const EVENT_TYPES = [
  "video.created",
  "video.uploaded",
  "video.ready",
  "video.failed",
  "video.cancelled",
  "video.deleted",
  "captions.ready",
  "download.ready",
] as const;

export interface Webhook {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actor: { type: "api_key" | "system" | "cli"; id: string | null };
  action: string;
  resource: { type: string; id: string | null };
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UsageDay {
  day: string;
  videosCreated: number;
  transcodeSeconds: number;
  playbackSessions: number;
  keyDeliveries: number;
}

export interface Usage {
  days: UsageDay[];
  totals: Omit<UsageDay, "day">;
}
