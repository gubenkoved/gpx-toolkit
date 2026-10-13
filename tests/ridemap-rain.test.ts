import { describe, expect, it } from "vitest";
import { rainLaneHtml } from "../src/ridemap";

/** 11 points 1 km apart going north (≈0.009° of latitude per km). */
const pts: [number, number][] = Array.from({ length: 11 }, (_, i) => [52 + i * 0.008993, 4.9]);
const linear = (km: number): number => (km / 10) * 1000;

describe("ride map rain lane", () => {
  it("draws a bar where it rained, sized by mm/h, and labels the peak there", () => {
    const rain = [0, 0, 0.3, 1.5, 6, 0, 0, 0, 0.05, 0, 0];
    const html = rainLaneHtml(pts, rain, 10, linear);
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const rects = [...doc.querySelectorAll("rect")];
    expect(rects.map((r) => r.getAttribute("class"))).toEqual(["rr1", "rr2", "rr3"]);
    // Taller for heavier rain; the 6 mm/h bar is full height (capped at 4 mm/h).
    const h = rects.map((r) => Number(r.getAttribute("height")));
    expect(h[0]).toBeLessThan(h[1]);
    expect(h[2]).toBeCloseTo(18, 1);
    // Bars sit where the rain fell: the 6 mm/h point is at km 4 → x ≈ 400.
    const x = Number(rects[2].getAttribute("x"));
    const w = Number(rects[2].getAttribute("width"));
    expect(x).toBeLessThan(400);
    expect(x + w).toBeGreaterThan(400);
    const peak = doc.querySelector(".rp-rain-peak");
    expect(peak?.textContent).toBe("6.0 mm/h");
    // Beside its bar (just right of it), never over it.
    expect(peak?.getAttribute("style")).toMatch(/^left:calc\(4\d\.\d% \+ 4px\)$/);
  });

  it("says dry when nothing fell, and draws nothing without rain data", () => {
    const dry = rainLaneHtml(
      pts,
      pts.map(() => 0),
      10,
      linear,
    );
    expect(dry).toContain("dry the whole way");
    expect(dry).not.toContain("<rect");
    expect(
      rainLaneHtml(
        pts,
        pts.map(() => null),
        10,
        linear,
      ),
    ).toBe("");
  });
});
