import { describe, expect, it } from "vitest";
import { brouterUrl, parseBrouterGeojson, RoutingError, routeLeg } from "../src/routing";

const GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { "track-length": "1200" },
      geometry: {
        type: "LineString",
        coordinates: [
          [4.9, 52.37, 1.5],
          [4.905, 52.372, 2],
          [4.91, 52.375],
        ],
      },
    },
  ],
};

describe("bike routing (BRouter)", () => {
  it("asks for one leg in lon,lat order with the profile", () => {
    const url = brouterUrl([52.37, 4.9], [52.375, 4.91], "trekking");
    expect(url).toContain("lonlats=4.900000,52.370000|4.910000,52.375000");
    expect(url).toContain("profile=trekking");
    expect(url).toContain("format=geojson");
  });

  it("parses the line into lat/lon points with elevation where given", () => {
    const leg = parseBrouterGeojson(GEOJSON);
    expect(leg.points).toEqual([
      [52.37, 4.9],
      [52.372, 4.905],
      [52.375, 4.91],
    ]);
    expect(leg.eles).toEqual([1.5, 2, null]);
    expect(leg.snapped).toBe(true);
  });

  it("draws a straight leg without the network", async () => {
    let calls = 0;
    const leg = await routeLeg([52, 4], [52.1, 4.1], "straight", (() => {
      calls++;
      return Promise.reject(new Error("no"));
    }) as unknown as typeof fetch);
    expect(calls).toBe(0);
    expect(leg).toEqual({
      points: [
        [52, 4],
        [52.1, 4.1],
      ],
      eles: [null, null],
      snapped: false,
    });
  });

  it("surfaces the router's plain-text error", async () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response("from-position not mapped in existing datafile\n", { status: 400 }),
      )) as unknown as typeof fetch;
    await expect(routeLeg([0, 0], [0.1, 0.1], "trekking", fetchFn)).rejects.toThrow(
      new RoutingError("from-position not mapped in existing datafile"),
    );
  });

  it("routes a leg through the injected fetch", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response(JSON.stringify(GEOJSON)))) as unknown as typeof fetch;
    const leg = await routeLeg([52.37, 4.9], [52.375, 4.91], "safety", fetchFn);
    expect(leg.points).toHaveLength(3);
  });
});
