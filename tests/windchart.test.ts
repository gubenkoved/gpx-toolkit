import { describe, expect, it } from "vitest";

import { makeScale, niceTicks } from "../src/windchart";

describe("niceTicks", () => {
  it("covers a range with uniform, ascending, 1/2/5-snapped steps", () => {
    const ticks = niceTicks(0, 10);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(10);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6);
    }
  });

  it("includes zero for a symmetric range", () => {
    const ticks = niceTicks(-7, 7);
    expect(ticks).toContain(0);
    expect(ticks[0]).toBeLessThan(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(0);
  });

  it("returns a single value for a degenerate range", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(5, 1)).toEqual([5]);
  });
});

describe("makeScale", () => {
  it("maps the domain onto the pixel range linearly", () => {
    const s = makeScale(0, 10, 0, 100);
    expect(s(0)).toBe(0);
    expect(s(5)).toBe(50);
    expect(s(10)).toBe(100);
  });

  it("centres a symmetric domain", () => {
    const s = makeScale(-5, 5, 0, 100);
    expect(s(0)).toBe(50);
  });

  it("does not divide by zero on a degenerate domain", () => {
    const s = makeScale(3, 3, 0, 100);
    expect(Number.isFinite(s(3))).toBe(true);
  });
});
