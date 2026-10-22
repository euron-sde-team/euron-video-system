import { describe, expect, it, vi } from "vitest";
import { formatBytes, formatDuration, formatMinutes, formatRelative, shortId, describeScopes } from "../src/lib/format";

describe("formatBytes", () => {
  it("uses binary units with one decimal below 10", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(720 * 1024 ** 2)).toBe("720 MB");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(formatBytes(3 * 1024 ** 5)).toBe("3072 TB");
  });

  it("renders a dash for empty, zero or negative sizes", () => {
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(-5)).toBe("-");
  });
});

describe("formatDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(245)).toBe("4:05");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("renders a dash when unknown", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
  });
});

describe("formatRelative", () => {
  it("formats past and future offsets compactly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
    expect(formatRelative("2026-01-10T11:59:50Z")).toBe("just now");
    expect(formatRelative("2026-01-10T11:57:00Z")).toBe("3m ago");
    expect(formatRelative("2026-01-10T10:00:00Z")).toBe("2h ago");
    expect(formatRelative("2026-01-05T12:00:00Z")).toBe("5d ago");
    expect(formatRelative("2026-01-10T12:05:00Z")).toBe("in 5m");
    expect(formatRelative(null)).toBe("-");
    expect(formatRelative("not a date")).toBe("-");
    vi.useRealTimers();
  });
});

describe("formatMinutes / shortId", () => {
  it("switches to hours past 60 minutes", () => {
    expect(formatMinutes(90)).toBe("2 min");
    expect(formatMinutes(3600 * 12.4)).toBe("12.4 h");
  });

  it("shortens long ids and leaves short ones", () => {
    expect(shortId("01JABCDEFGHJKMNPQRSTVWXYZ")).toBe("01JA...WXYZ");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("describeScopes", () => {
  it("labels the wildcard as all scopes and pluralizes counts", () => {
    expect(describeScopes(["*"])).toBe("all scopes");
    expect(describeScopes(["playback:mint"])).toBe("1 scope");
    expect(describeScopes(["videos:read", "videos:write"])).toBe("2 scopes");
    expect(describeScopes([])).toBe("0 scopes");
  });
});
