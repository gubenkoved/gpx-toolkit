import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AreaSelect, createAreaSelect } from "../src/areaselect";
import type { RideTrack } from "../src/mapview";

/**
 * A minimal stand-in for the bits of `L.Map` the area-select gesture touches. The
 * projection is deliberately trivial — lat maps to the y pixel and lon to the x
 * pixel (and back) — so a track point at [lat, lon] sits at container pixel
 * (lon, lat). That keeps the geometry easy to reason about in assertions.
 */
function fakeMap() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const clickHandlers: ((e: { containerPoint: { x: number; y: number } }) => void)[] = [];
  const dragging = { disable: vi.fn(), enable: vi.fn() };
  const boxZoom = { disable: vi.fn(), enable: vi.fn() };
  const map = {
    container,
    dragging,
    boxZoom,
    on: (ev: string, fn: (e: { containerPoint: { x: number; y: number } }) => void) => {
      if (ev === "click") clickHandlers.push(fn);
    },
    fireClick: (x: number, y: number) => {
      for (const fn of clickHandlers) fn({ containerPoint: { x, y } });
    },
    getContainer: () => container,
    mouseEventToContainerPoint: (e: MouseEvent) => ({ x: e.clientX, y: e.clientY }),
    containerPointToLatLng: ([x, y]: [number, number]) => ({ lat: y, lng: x }),
    latLngToContainerPoint: ([lat, lon]: [number, number]) => ({ x: lon, y: lat }),
  };
  // The controller is typed against L.Map; this fake only implements what it uses.
  return map as typeof map;
}

const TRACKS: RideTrack[] = [
  {
    key: "A",
    title: "Ride A",
    points: [
      [10, 10],
      [10, 14],
    ],
  }, // near pixel (10–14, 10)
  {
    key: "B",
    title: "Ride B",
    points: [
      [80, 80],
      [84, 80],
    ],
  }, // near pixel (80, 80–84)
];

/** Drive a container-pixel drag through the controller's real DOM listeners. */
function drag(container: HTMLElement, from: [number, number], to: [number, number]): void {
  container.dispatchEvent(
    new MouseEvent("mousedown", {
      clientX: from[0],
      clientY: from[1],
      button: 0,
      bubbles: true,
    }),
  );
  container.dispatchEvent(
    new MouseEvent("mousemove", { clientX: to[0], clientY: to[1], bubbles: true }),
  );
  window.dispatchEvent(
    new MouseEvent("mouseup", { clientX: to[0], clientY: to[1], bubbles: true }),
  );
}

describe("createAreaSelect", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles the button state/class and map panning when armed/disarmed", () => {
    const map = fakeMap();
    const button = document.createElement("button");
    const sel: AreaSelect = createAreaSelect({
      getMap: () => map as never,
      getTracks: () => TRACKS,
      button,
      onSelect: () => {},
    });
    sel.attach();

    expect(sel.isArmed()).toBe(false);
    sel.setMode(true);
    expect(sel.isArmed()).toBe(true);
    expect(button.classList.contains("active")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Cancel selection");
    expect(map.container.classList.contains("selecting")).toBe(true);
    expect(map.dragging.disable).toHaveBeenCalled();
    expect(map.boxZoom.disable).toHaveBeenCalled();

    sel.setMode(false);
    expect(sel.isArmed()).toBe(false);
    expect(button.classList.contains("active")).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Select area");
    expect(map.container.classList.contains("selecting")).toBe(false);
    expect(map.dragging.enable).toHaveBeenCalled();
  });

  it("selects the nearest ride on a click and clears on a miss", () => {
    const map = fakeMap();
    const onSelect = vi.fn();
    const sel = createAreaSelect({
      getMap: () => map as never,
      getTracks: () => TRACKS,
      button: null,
      onSelect,
    });
    sel.attach();

    map.fireClick(12, 10); // right on ride A's line
    expect(onSelect).toHaveBeenLastCalledWith(["A"]);

    map.fireClick(50, 50); // far from every track
    expect(onSelect).toHaveBeenLastCalledWith([]);
  });

  it("ignores clicks while armed (the drag gesture owns them)", () => {
    const map = fakeMap();
    const onSelect = vi.fn();
    const sel = createAreaSelect({
      getMap: () => map as never,
      getTracks: () => TRACKS,
      button: null,
      onSelect,
    });
    sel.attach();
    sel.setMode(true);

    map.fireClick(12, 10);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects every ride crossing the drag box and auto-disarms", () => {
    vi.useFakeTimers();
    const map = fakeMap();
    const onSelect = vi.fn();
    const sel = createAreaSelect({
      getMap: () => map as never,
      getTracks: () => TRACKS,
      button: null,
      onSelect,
    });
    sel.attach();
    sel.setMode(true);

    // Box from (5,5) to (20,20) covers ride A's points (lon 10–14, lat 10) only.
    drag(map.container, [5, 5], [20, 20]);
    expect(onSelect).toHaveBeenCalledWith(["A"]);

    // The trailing disarm is deferred to a 0ms timeout.
    vi.runAllTimers();
    expect(sel.isArmed()).toBe(false);
    vi.useRealTimers();
  });

  it("treats a sub-threshold drag as a non-selection (no box filter)", () => {
    const map = fakeMap();
    const onSelect = vi.fn();
    const sel = createAreaSelect({
      getMap: () => map as never,
      getTracks: () => TRACKS,
      button: null,
      onSelect,
    });
    sel.attach();
    sel.setMode(true);

    drag(map.container, [10, 10], [12, 12]); // < 4px on each axis
    expect(onSelect).not.toHaveBeenCalled();
  });
});
