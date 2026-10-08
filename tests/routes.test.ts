import { describe, expect, it } from "vitest";
import { memoryBackend } from "../src/kv";
import {
  climbM,
  newRoute,
  parseLibrary,
  RouteStore,
  routeFromGpx,
  routeStats,
  routeToGpx,
  routeTrack,
  thinTrack,
} from "../src/routes";

function planned() {
  const r = newRoute("trekking", Date.UTC(2026, 9, 8));
  r.name = "Coast loop";
  r.waypoints = [
    [52.0, 4.0],
    [52.01, 4.0],
    [52.01, 4.02],
  ];
  r.legs = [
    {
      points: [
        [52.0, 4.0],
        [52.005, 4.0],
        [52.01, 4.0],
      ],
      eles: [0, 10, 20],
      snapped: true,
    },
    {
      points: [
        [52.01, 4.0],
        [52.01, 4.02],
      ],
      eles: [20, 5],
      snapped: false,
    },
  ];
  return r;
}

describe("library routes", () => {
  it("joins legs into one line without repeating the junction", () => {
    const t = routeTrack(planned());
    expect(t.points).toHaveLength(4);
    expect(t.eles).toEqual([0, 10, 20, 5]);
    expect(t.cum[0]).toBe(0);
    expect(t.cum[3]).toBeGreaterThan(2.4);
  });

  it("counts climb above the noise band only", () => {
    expect(climbM([0, 1, 0, 1, 0, 1])).toEqual({ ascent: 0, descent: 0 });
    expect(climbM([0, 10, 20, 5])).toEqual({ ascent: 20, descent: 15 });
    expect(climbM([null, 5])).toBeNull();
    expect(routeStats(planned()).ascentM).toBe(20);
  });

  it("round-trips through GPX as a fixed, imported route", () => {
    const gpx = routeToGpx(planned());
    expect(gpx).toContain("<name>Coast loop</name>");
    const back = routeFromGpx(gpx, "Coast loop")!;
    expect(back.imported).toBe(true);
    expect(back.legs).toHaveLength(1);
    expect(back.waypoints[0]).toEqual([52, 4]);
    expect(back.waypoints[1]).toEqual([52.01, 4.02]);
    expect(routeFromGpx("<gpx></gpx>", "x")).toBeNull();
  });

  it("thins a dense recording but keeps both ends", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 100; i++) pts.push([52 + i * 0.00001, 4]); // ~1.1 m apart
    const t = thinTrack(
      pts,
      pts.map(() => null),
      15,
    );
    expect(t.points.length).toBeLessThan(12);
    expect(t.points[0]).toEqual(pts[0]);
    expect(t.points[t.points.length - 1]).toEqual(pts[100]);
  });

  it("persists and merges the library", async () => {
    const kv = memoryBackend();
    const a = new RouteStore(kv);
    await a.load();
    const r = planned();
    await a.put(r);
    const b = new RouteStore(kv);
    await b.load();
    const got = b.get(r.id)!;
    expect(got.name).toBe("Coast loop");
    expect(got.waypoints).toEqual(r.waypoints);
    expect(got.legs[0].eles).toEqual([0, 10, 20]);
    expect(got.legs[1].snapped).toBe(false);

    // Importing keeps the newer edit of a known id and adds unknown ones.
    const older = JSON.parse(a.exportJson());
    older.routes[0].name = "Old name";
    older.routes[0].updated = r.updated - 1;
    older.routes.push({ ...older.routes[0], id: "route-other", name: "Other" });
    expect(await b.importJson(JSON.stringify(older))).toBe(1);
    expect(b.get(r.id)?.name).toBe("Coast loop");
    expect(b.get("route-other")?.name).toBe("Other");
    expect(parseLibrary("not json")).toEqual([]);
  });
});
