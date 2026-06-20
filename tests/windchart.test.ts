import { describe, expect, it } from "vitest";

import { type ChartDot, makeScale, nearestDot, niceTicks } from "../src/windchart";
import type { WindSeg } from "../src/windspeed";

/** Minimal stub segment — only `uid` matters for the hit-test tests. */
function seg(uid: string): WindSeg {
  return {
    uid,
    avgSpeedKmh: 20,
    avgAlongKmh: 0,
    avgCrossKmh: 0,
    distanceKm: 1,
    movingSec: 180,
    netGradePct: 0,
  };
}

function dot(uid: string, x: number, y: number, r: number): ChartDot {
  return { seg: seg(uid), x, y, r };
}

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

describe("nearestDot", () => {
  it("returns the dot under the pointer (within its radius)", () => {
    const dots = [dot("a", 10, 10, 4), dot("b", 100, 100, 4)];
    expect(nearestDot(dots, 11, 11, 0)?.seg.uid).toBe("a");
  });

  it("honours the slack ring around a dot", () => {
    const dots = [dot("a", 50, 50, 3)];
    // 8px away, dot r=3: reachable only once slack >= 5.
    expect(nearestDot(dots, 58, 50, 4)).toBeNull();
    expect(nearestDot(dots, 58, 50, 6)?.seg.uid).toBe("a");
  });

  it("returns null when nothing is within reach", () => {
    const dots = [dot("a", 10, 10, 3), dot("b", 200, 200, 3)];
    expect(nearestDot(dots, 100, 100, 5)).toBeNull();
  });

  it("picks the closest among overlapping dots", () => {
    const dots = [dot("far", 60, 50, 6), dot("near", 52, 50, 6)];
    expect(nearestDot(dots, 50, 50, 16)?.seg.uid).toBe("near");
  });

  it("breaks a tie toward the smaller (more specific) dot", () => {
    const dots = [dot("big", 50, 50, 8), dot("small", 50, 50, 2)];
    expect(nearestDot(dots, 50, 50, 10)?.seg.uid).toBe("small");
  });
});
