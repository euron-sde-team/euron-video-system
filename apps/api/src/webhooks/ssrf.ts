import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for webhook targets.
 *
 * A webhook URL is attacker-influenced input that this server will POST to. In
 * production we refuse any target that resolves to a loopback, private,
 * link-local (including the 169.254.169.254 instance-metadata endpoint), CGNAT
 * or otherwise non-public address, so a webhook cannot be used to probe the
 * VPC or steal instance credentials. The check runs at registration AND before
 * every delivery, because DNS can change between the two (DNS rebinding).
 */

const v4ToInt = (ip: string): number => ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export const isPrivateAddress = (ip: string): boolean => {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return true; // not an IP at all: treat as unsafe
};

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Throws when `rawUrl` is not an acceptable webhook target.
 * @param enforce false in development, so local receivers (localhost) work.
 */
export const assertSafeWebhookUrl = async (
  rawUrl: string,
  enforce: boolean,
  resolve: Resolver = defaultResolver
): Promise<void> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("webhook URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("webhook URL must not contain credentials");
  if (!enforce) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("webhook URL must be http(s)");
    return;
  }
  if (url.protocol !== "https:") throw new Error("webhook URL must use https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("webhook URL resolves to a non-public address");
  }
};
