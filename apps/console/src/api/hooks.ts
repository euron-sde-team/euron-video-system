import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../lib/api";
import { useSettings } from "../lib/settings";
import {
  TERMINAL,
  type ApiKey,
  type AuditEvent,
  type CreateVideoResponse,
  type CursorPage,
  type Me,
  type Paginated,
  type PlaybackPolicy,
  type PlaybackSession,
  type PlaybackSessionGrant,
  type Stats,
  type Usage,
  type Video,
  type Webhook,
  type WebhookDelivery,
} from "../lib/types";

// Every query key starts with the connection, so switching API base or key never shows stale data.
const useConn = () => {
  const s = useSettings();
  return [s.apiBase, s.apiKey.slice(0, 16)] as const;
};

export const qk = {
  all: ["evs"] as const,
};

// ─── Identity + stats ────────────────────────────────────────────────────────

export const useMe = (enabled = true) => {
  const conn = useConn();
  return useQuery({ queryKey: [...qk.all, conn, "me"], queryFn: () => get<Me>("/me"), enabled, retry: false, staleTime: 60_000 });
};

export const useStats = () => {
  const conn = useConn();
  return useQuery({ queryKey: [...qk.all, conn, "stats"], queryFn: () => get<Stats>("/stats"), refetchInterval: 5000 });
};

// ─── Videos ──────────────────────────────────────────────────────────────────

export interface VideoFilters {
  status?: string;
  q?: string;
  page?: number;
  limit?: number;
}

const anyInFlight = (videos: Video[] | undefined) => !!videos?.some((v) => !TERMINAL.includes(v.status));

export const useVideos = (filters: VideoFilters) => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "videos", filters],
    queryFn: () => get<Paginated<Video>>("/videos", { ...filters }),
    placeholderData: keepPreviousData,
    // Poll only while something on screen is still moving through the pipeline.
    refetchInterval: (q) => (anyInFlight(q.state.data?.data) ? 3000 : false),
  });
};

export const useVideo = (id: string | undefined) => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "video", id],
    queryFn: () => get<Video>(`/videos/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const v = q.state.data;
      if (!v) return false;
      const artifactsPending = [v.captions.status, v.download.status].some((s) => s === "pending" || s === "processing");
      return !TERMINAL.includes(v.status) || (v.status === "ready" && artifactsPending) ? 3000 : false;
    },
  });
};

const useInvalidate = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: qk.all });
};

export const useVideoAction = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "cancel" }) => post<Video>(`/videos/${id}/${action}`),
    onSettled: invalidate,
  });
};

export const useUpdateVideo = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; playbackPolicyId?: string | null }) => patch<Video>(`/videos/${id}`, body),
    onSettled: invalidate,
  });
};

export const useDeleteVideo = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => del(`/videos/${id}`), onSettled: invalidate });
};

export const createVideo = (body: { title: string; filename: string; playbackPolicyId?: string }) => post<CreateVideoResponse>("/videos", body);
export const completeVideo = (id: string) => post<Video>(`/videos/${id}/complete`);
export const getDownloadUrl = (id: string) => get<{ url: string; expiresAt: string; filename: string }>(`/videos/${id}/download`);
export const createPlaybackSession = (id: string, viewerId: string, ttlSeconds?: number) =>
  post<PlaybackSessionGrant>(`/videos/${id}/playback-sessions`, { viewerId, ...(ttlSeconds ? { ttlSeconds } : {}) });

export const useInvalidateAll = useInvalidate;

// ─── Playback sessions ───────────────────────────────────────────────────────

export const useSessions = (params: { videoId?: string; active?: boolean; page?: number; limit?: number }) => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "sessions", params],
    queryFn: () => get<Paginated<PlaybackSession>>("/playback-sessions", { ...params }),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
};

export const useRevokeSession = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => del(`/playback-sessions/${id}`), onSettled: invalidate });
};

// ─── Playback policies ───────────────────────────────────────────────────────

export type PolicyInput = Omit<PlaybackPolicy, "id" | "createdAt" | "updatedAt">;

export const usePolicies = () => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "policies"],
    queryFn: () => get<Paginated<PlaybackPolicy>>("/playback-policies", { limit: 100 }),
  });
};

export const useSavePolicy = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<PolicyInput> & { id?: string }) =>
      id ? patch<PlaybackPolicy>(`/playback-policies/${id}`, body) : post<PlaybackPolicy>("/playback-policies", body),
    onSettled: invalidate,
  });
};

export const useDeletePolicy = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => del(`/playback-policies/${id}`), onSettled: invalidate });
};

// ─── API keys ────────────────────────────────────────────────────────────────

export const useApiKeys = () => {
  const conn = useConn();
  return useQuery({ queryKey: [...qk.all, conn, "keys"], queryFn: () => get<Paginated<ApiKey>>("/api-keys", { limit: 100 }) });
};

export const useCreateApiKey = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[]; expiresAt?: string }) => post<{ apiKey: ApiKey; secret: string }>("/api-keys", body),
    onSettled: invalidate,
  });
};

export const useRevokeApiKey = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => del(`/api-keys/${id}`), onSettled: invalidate });
};

// ─── Webhooks ────────────────────────────────────────────────────────────────

export const useWebhooks = () => {
  const conn = useConn();
  return useQuery({ queryKey: [...qk.all, conn, "webhooks"], queryFn: () => get<Paginated<Webhook>>("/webhooks", { limit: 100 }) });
};

export const useCreateWebhook = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { url: string; events: string[]; description?: string }) => post<{ webhook: Webhook; signingSecret: string }>("/webhooks", body),
    onSettled: invalidate,
  });
};

export const useUpdateWebhook = () => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled?: boolean; events?: string[]; url?: string; description?: string }) => patch<Webhook>(`/webhooks/${id}`, body),
    onSettled: invalidate,
  });
};

export const useDeleteWebhook = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => del(`/webhooks/${id}`), onSettled: invalidate });
};

export const useTestWebhook = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => post(`/webhooks/${id}/test`), onSettled: invalidate });
};

export const useDeliveries = (webhookId: string | null) => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "deliveries", webhookId],
    queryFn: () => get<Paginated<WebhookDelivery>>(`/webhooks/${webhookId}/deliveries`, { limit: 50 }),
    enabled: !!webhookId,
    refetchInterval: 5000,
  });
};

export const useRedeliver = () => {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => post(`/webhook-deliveries/${id}/redeliver`), onSettled: invalidate });
};

// ─── Audit + usage ───────────────────────────────────────────────────────────

export interface AuditFilters {
  action?: string;
  resourceType?: string;
  resourceId?: string;
}

export const useAudit = (filters: AuditFilters, cursor: string | null) => {
  const conn = useConn();
  return useQuery({
    queryKey: [...qk.all, conn, "audit", filters, cursor],
    queryFn: () => get<CursorPage<AuditEvent>>("/audit-events", { ...filters, cursor, limit: 50 }),
    placeholderData: keepPreviousData,
  });
};

export const useUsage = (from: string, to: string) => {
  const conn = useConn();
  return useQuery({ queryKey: [...qk.all, conn, "usage", from, to], queryFn: () => get<Usage>("/usage", { from, to }) });
};
