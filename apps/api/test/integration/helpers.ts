import { sql } from "kysely";
import request from "supertest";
import type { Express } from "express";
import { getDb } from "@evs/core/db";
import { createApp } from "../../src/app.js";
import apiKeysService from "../../src/services/api-keys.service.js";
import type { Scope } from "../../src/services/api-key-format.js";
import { objects, putObject } from "./fake-storage.js";

let app: Express | null = null;
export const getApp = (): Express => (app ??= createApp());

/** Mint a key directly through the service (as the CLI does) and return its secret. */
export const createKey = async (scopes: Array<Scope | "*"> = ["*"], name = "itest"): Promise<string> => {
  const { secret } = await apiKeysService.create(null, { name, scopes });
  return secret;
};

export const authed = (key: string) => {
  const a = request(getApp());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${key}`);
  return {
    get: (p: string) => auth(a.get(p)),
    post: (p: string) => auth(a.post(p)),
    patch: (p: string) => auth(a.patch(p)),
    delete: (p: string) => auth(a.delete(p)),
  };
};

export const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720/index.m3u8
`;
export const VARIANT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="EVS_KEY_URI"
#EXTINF:4.000,
seg_00000.ts
#EXT-X-ENDLIST
`;

/**
 * A video that went through create -> upload -> complete, then flipped to
 * 'ready' with a stored HLS tree, the way a worker would leave it.
 */
export const createReadyVideo = async (key: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const created = await authed(key).post("/v1/videos").send({ title: "Ready video", filename: "clip.mp4", ...extra });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.video.id as string;
  putObject("uploads", `uploads/${id}/original.mp4`, Buffer.alloc(1024));
  const done = await authed(key).post(`/v1/videos/${id}/complete`);
  if (done.status !== 200) throw new Error(`complete failed: ${done.status}`);
  await sql`UPDATE videos SET status = 'ready', progress = 100, ready_at = now(), duration_seconds = 42 WHERE id = ${id}`.execute(getDb());
  putObject("media", `media/${id}/hls/master.m3u8`, MASTER);
  putObject("media", `media/${id}/hls/720/index.m3u8`, VARIANT);
  putObject("media", `media/${id}/thumbnails/thumbnails.vtt`, "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite_000.jpg#xywh=0,0,160,90\n");
  return id;
};

export const clearObjects = (): void => objects.clear();

/** Path + query of an absolute URL, for replaying through supertest. */
export const pathOf = (url: string): string => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};
