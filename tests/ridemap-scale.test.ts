import { describe, expect, it } from "vitest";
import { rampColor, robustScale } from "../src/ridemap";

describe("ride map colour scale", () => {
  it("ignores a short spike and clamps it to the top colour", () => {
    // 100 equal-distance points cruising 18–28 km/h, plus one 46 km/h spike.
    const values: number[] = Array.from({ length: 100 }, (_, i) => 18 + (i % 11));
    values[50] = 46;
    const s = robustScale(
      values,
      values.map(() => 1),
      4,
    );
    expect(s).not.toBeNull();
    expect(s!.hi).toBeLessThan(30);
    expect(s!.lo).toBeGreaterThanOrEqual(18);
    expect(s!.clampHi).toBe(true);
  });

  it("leaves zero-weight points (stops) out of the scale", () => {
    const values = [0, 0, 0, 20, 22, 24, 26, 0];
    const weights = [0, 0, 0, 1, 1, 1, 1, 0];
    const s = robustScale(values, weights, 4, 0)!;
    expect(s.lo).toBe(20);
    expect(s.hi).toBe(26);
    expect(s.clampLo).toBe(false);
  });

  it("weights by distance, not by point count", () => {
    // Many dense slow fixes over a short distance vs. few fast fixes over a long one.
    const values = [...Array(50).fill(10), ...Array(5).fill(30)];
    const weights = [...Array(50).fill(0.01), ...Array(5).fill(1)];
    const s = robustScale(values, weights, 1, 0.05)!;
    expect(s.lo).toBe(10);
    expect(s.hi).toBe(30);
  });

  it("widens a near-constant series to the minimum span without going negative", () => {
    const s = robustScale([1, 1, 1], [1, 1, 1], 10)!;
    expect(s.hi - s.lo).toBeCloseTo(10);
    expect(s.lo).toBe(0);
    expect(robustScale([null, null], [1, 1], 4)).toBeNull();
  });

  it("maps the ends of the ramp to distinct colours and clamps outside", () => {
    expect(rampColor(0)).toBe("rgb(59,111,224)");
    expect(rampColor(1)).toBe("rgb(232,50,43)");
    expect(rampColor(-3)).toBe(rampColor(0));
    expect(rampColor(7)).toBe(rampColor(1));
    expect(rampColor(0.5)).not.toBe(rampColor(0.4));
  });
});
