import { describe, expect, it } from "vitest";
import { dayRange, layoutBars, niceMax } from "../src/lib/chart";

describe("niceMax", () => {
  it("rounds up to 1 / 2 / 2.5 / 5 x 10^n", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(250)).toBe(250);
    expect(niceMax(4100)).toBe(5000);
  });
});

describe("layoutBars", () => {
  it("scales bars against the nice max and anchors them at the bottom", () => {
    const { bars, max } = layoutBars(
      [
        { label: "a", value: 10 },
        { label: "b", value: 5 },
        { label: "c", value: 0 },
        { label: "d", value: 2 },
      ],
      400,
      100,
      0
    );
    expect(max).toBe(10);
    expect(bars.map((b) => b.height)).toEqual([100, 50, 0, 20]);
    expect(bars.map((b) => b.y)).toEqual([0, 50, 100, 80]);
    expect(bars.map((b) => b.x)).toEqual([0, 100, 200, 300]);
  });

  it("handles empty input", () => {
    expect(layoutBars([], 100, 100).bars).toEqual([]);
  });
});

describe("dayRange", () => {
  it("lists inclusive UTC days across month boundaries", () => {
    expect(dayRange("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
    expect(dayRange("2026-03-05", "2026-03-04")).toEqual([]);
    expect(dayRange("bad", "2026-03-04")).toEqual([]);
  });
});
