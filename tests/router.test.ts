import { afterEach, describe, expect, it } from "vitest";
import { formatRoute, parseRoute, writeRoute } from "../src/router";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("hash routes", () => {
  it("round-trips all tabs and point routes at six decimal places", () => {
    for (const view of [
      "explore",
      "map",
      "stats",
      "analytics",
      "climate",
      "forecast",
      "timeline",
    ] as const) {
      expect(parseRoute(formatRoute({ view }))).toEqual({ view });
    }
    const route = { view: "climate" as const, point: { lat: 52.37012345, lon: -4.90012345 } };
    expect(formatRoute(route)).toBe("#/wind-rose?lat=52.370123&lon=-4.900123");
    expect(parseRoute(formatRoute(route))).toEqual({
      view: "climate",
      point: { lat: 52.370123, lon: -4.900123 },
    });
    expect(parseRoute("#/forecast?lon=180&lat=-90")).toEqual({
      view: "forecast",
      point: { lat: -90, lon: 180 },
    });
  });

  it("rejects missing, unknown and out-of-bounds coordinates", () => {
    for (const hash of [
      "",
      "#",
      "#/unknown",
      "#/forecast?lat=91&lon=4",
      "#/wind-rose?lat=52&lon=-181",
      "#/forecast?lat=NaN&lon=4",
      "#/forecast?lat=&lon=4",
      "#/forecast?lat=52",
      "#/map?lat=52&lon=4",
    ]) {
      expect(parseRoute(hash)).toBeNull();
    }
    expect(() => formatRoute({ view: "forecast", point: { lat: 91, lon: 4 } })).toThrow(
      RangeError,
    );
  });

  it("pushes screens and replaces point changes without adding a history entry", () => {
    window.history.replaceState(null, "", "/app?x=1#/explore");
    const start = window.history.length;
    writeRoute({ view: "forecast" }, "push");
    expect(window.history.length).toBe(start + 1);
    writeRoute({ view: "forecast", point: { lat: 52.37, lon: 4.9 } }, "replace");
    expect(window.history.length).toBe(start + 1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/app?x=1#/forecast?lat=52.370000&lon=4.900000",
    );
  });

  it("exposes earlier routes to Back and Forward navigation", async () => {
    window.history.replaceState(null, "", "/#/explore");
    writeRoute({ view: "forecast" }, "push");
    writeRoute({ view: "forecast", point: { lat: 52.37, lon: 4.9 } }, "replace");
    writeRoute({ view: "map" }, "push");
    window.history.back();
    await expect
      .poll(() => parseRoute(window.location.hash))
      .toEqual({
        view: "forecast",
        point: { lat: 52.37, lon: 4.9 },
      });
    window.history.forward();
    await expect.poll(() => parseRoute(window.location.hash)).toEqual({ view: "map" });
  });
});
