import { execFileSync } from "node:child_process";
import os from "node:os";
import { getWorkerConfig } from "@evs/core/config";
import logger from "@evs/core/logger";

/**
 * Where the worker runs, and what that implies:
 *
 *   ec2    identity = EC2 instance id from IMDSv2; watches the Spot interruption
 *          notice; self-terminates the instance when idle (the launch template
 *          sets shutdown-behavior=terminate, so `shutdown -h` ends the instance).
 *   local  identity = WORKER_ID or the hostname (one per container); no IMDS,
 *          never interrupted, never shuts down. Used by docker compose.
 */
export interface Platform {
  readonly kind: "ec2" | "local";
  workerId(): Promise<string>;
  /** True once a Spot interruption notice (~2 minutes' warning) has been issued. */
  interruptionPending(): Promise<boolean>;
  /** Called when the queue has been empty for IDLE_GRACE_MS. */
  shutdownWhenIdle(): boolean;
}

const IMDS = "http://169.254.169.254";

const fetchWithTimeout = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
};

/**
 * IMDSv2 only. The launch template sets HttpTokens=required, so the v1
 * (tokenless) path is disabled at the instance; there is no fallback to it.
 */
const imdsToken = async (): Promise<string | null> => {
  try {
    const res = await fetchWithTimeout(`${IMDS}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "120" },
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

const getMetadata = async (path: string): Promise<{ status: number; body: string } | null> => {
  const token = await imdsToken();
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(`${IMDS}/latest/meta-data/${path}`, {
      headers: { "X-aws-ec2-metadata-token": token },
    });
    return { status: res.status, body: res.ok ? await res.text() : "" };
  } catch {
    return null;
  }
};

const ec2Platform: Platform = {
  kind: "ec2",
  /** Worker id = EC2 instance id: the orchestrator counts workers from EC2, never a DB table. */
  async workerId() {
    const configured = getWorkerConfig().WORKER_ID;
    if (configured) return configured;
    const meta = await getMetadata("instance-id");
    if (meta?.status === 200 && meta.body) return meta.body.trim();
    throw new Error("WORKER_PLATFORM=ec2 but IMDSv2 is unreachable; set WORKER_PLATFORM=local outside EC2");
  },
  /**
   * The action endpoint returns 404 normally and 200 with {action, time} once a
   * ~2-minute interruption notice is issued.
   */
  async interruptionPending() {
    const meta = await getMetadata("spot/instance-action");
    return meta?.status === 200;
  },
  shutdownWhenIdle() {
    if (getWorkerConfig().WORKER_DRY_RUN_SHUTDOWN) {
      logger.info("[worker] (dry-run) would shut the instance down now");
      return true;
    }
    try {
      execFileSync("sudo", ["shutdown", "-h", "now"]);
    } catch (e) {
      logger.error(`[worker] shutdown failed: ${e}`);
    }
    return true;
  },
};

const localPlatform: Platform = {
  kind: "local",
  async workerId() {
    return getWorkerConfig().WORKER_ID ?? `local-${os.hostname()}-${process.pid}`;
  },
  async interruptionPending() {
    return false;
  },
  // Containers are long-lived: an idle local worker keeps polling.
  shutdownWhenIdle() {
    return false;
  },
};

export const getPlatform = (): Platform => (getWorkerConfig().WORKER_PLATFORM === "ec2" ? ec2Platform : localPlatform);
