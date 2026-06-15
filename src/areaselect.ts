/**
 * Reusable "area-select" rubber-band gesture for a Leaflet map.
 *
 * Drag a rectangle to select every ride whose track crosses it; a single click
 * selects the nearest ride within a few pixels (a miss clears the selection).
 * The gesture is rendering-agnostic: it owns only its own arm/disarm + drag
 * state and reports the chosen ride keys via `onSelect`, leaving every visual
 * (track emphasis, side panels, lists) to the caller. Both the Map view's
 * all-rides map and the Stats view's route-frequency heatmap mount one of these
 * so the interaction stays identical and lives in exactly one place.
 */
import type L from "leaflet";

import {
  type LatLngBox,
  nearestRides,
  type PixelPoint,
  type ProjectedTrack,
  type RideTrack,
  ridesInLatLngBox,
} from "./mapview";

export interface AreaSelectOptions {
  /** Lazily resolve the Leaflet map (it is created on first mount, after this controller). */
  getMap: () => L.Map | null;
  /** The drawable tracks to hit-test against, resolved fresh on each gesture. */
  getTracks: () => RideTrack[];
  /** The "Select area" toggle button (its armed/active state is managed here). */
  button: HTMLElement | null;
  /** Receives the selected ride keys: a box-drag yields all crossing it, a click the nearest one, a miss `[]`. */
  onSelect: (keys: string[]) => void;
  /** How close (screen px) a single click must land to "hit" a track. */
  clickPx?: number;
  /** Accessible label/tooltip while idle. */
  idleLabel?: string;
  /** Accessible label/tooltip while armed. */
  armedLabel?: string;
}

export interface AreaSelect {
  /** Wire the map + container + window listeners once the map exists (idempotent). */
  attach(): void;
  /** Arm or disarm the rubber-band selection. */
  setMode(on: boolean): void;
  /** Whether the gesture is currently armed. */
  isArmed(): boolean;
}

/** A real drag (vs. a stray click) must move at least this many px on either axis. */
const DRAG_THRESHOLD_PX = 4;

export function createAreaSelect(opts: AreaSelectOptions): AreaSelect {
  const clickPx = opts.clickPx ?? 8;
  const idleLabel = opts.idleLabel ?? "Select area";
  const armedLabel = opts.armedLabel ?? "Cancel selection";

  let armed = false;
  let dragStart: PixelPoint | null = null;
  let rubberBand: HTMLDivElement | null = null;
  let attached = false;
  // The pointer that started the current drag; ignore others (multi-touch) so a
  // second finger can't hijack or jitter the rubber-band mid-gesture.
  let activePointerId: number | null = null;

  /** Project the current tracks into container pixels for click hit-testing. */
  function projectTracks(map: L.Map): ProjectedTrack[] {
    return opts.getTracks().map((t) => ({
      key: t.key,
      pts: t.points.map(([lat, lon]) => {
        const p = map.latLngToContainerPoint([lat, lon]);
        return { x: p.x, y: p.y };
      }),
    }));
  }

  /** Convert two container-pixel corners into a lat/lng selection box. */
  function boxFromCorners(map: L.Map, a: PixelPoint, b: PixelPoint): LatLngBox {
    const c1 = map.containerPointToLatLng([a.x, a.y]);
    const c2 = map.containerPointToLatLng([b.x, b.y]);
    return {
      minLat: Math.min(c1.lat, c2.lat),
      maxLat: Math.max(c1.lat, c2.lat),
      minLon: Math.min(c1.lng, c2.lng),
      maxLon: Math.max(c1.lng, c2.lng),
    };
  }

  /** Resize the rubber-band rectangle to span from the drag origin to (x, y). */
  function updateRubber(x: number, y: number): void {
    if (!rubberBand || !dragStart) return;
    rubberBand.style.left = `${Math.min(dragStart.x, x)}px`;
    rubberBand.style.top = `${Math.min(dragStart.y, y)}px`;
    rubberBand.style.width = `${Math.abs(x - dragStart.x)}px`;
    rubberBand.style.height = `${Math.abs(y - dragStart.y)}px`;
  }

  /** Arm or disarm: toggle the button, the crosshair cursor, and map panning. */
  function setMode(on: boolean): void {
    armed = on;
    if (opts.button) {
      // The button is icon-only (its glyph swaps via CSS on `.active`); reflect the
      // armed state to assistive tech with aria-pressed + the matching label.
      opts.button.classList.toggle("active", on);
      opts.button.setAttribute("aria-pressed", on ? "true" : "false");
      opts.button.setAttribute("aria-label", on ? armedLabel : idleLabel);
    }
    const map = opts.getMap();
    const c = map?.getContainer();
    if (c) c.classList.toggle("selecting", on);
    // While selecting, panning/box-zoom would fight the rubber-band drag.
    if (map) {
      if (on) {
        map.dragging.disable();
        map.boxZoom.disable();
      } else {
        map.dragging.enable();
        map.boxZoom.enable();
      }
    }
    if (!on && rubberBand) {
      rubberBand.remove();
      rubberBand = null;
      dragStart = null;
    }
  }

  function onMapClick(e: L.LeafletMouseEvent): void {
    if (armed) return; // the area-drag gesture owns clicks while armed
    const map = opts.getMap();
    if (!map) return;
    // Project tracks on the fly for this one click (no per-frame cost), then
    // select the single nearest ride under the cursor. A miss clears it.
    const keys = nearestRides(
      projectTracks(map),
      { x: e.containerPoint.x, y: e.containerPoint.y },
      clickPx,
    );
    opts.onSelect(keys.length ? [keys[0]] : []);
  }

  function onDown(e: PointerEvent): void {
    const map = opts.getMap();
    if (!armed || !map || e.button !== 0) return;
    const p = map.mouseEventToContainerPoint(e);
    dragStart = { x: p.x, y: p.y };
    activePointerId = e.pointerId;
    // Capture the pointer so move/up keep firing on this element even if the
    // finger/cursor slides outside the map (essential for touch drags).
    try {
      map.getContainer().setPointerCapture(e.pointerId);
    } catch {
      // Older engines may reject capture; the gesture still works for mouse.
    }
    rubberBand = document.createElement("div");
    rubberBand.className = "map-rubber";
    map.getContainer().appendChild(rubberBand);
    updateRubber(p.x, p.y);
    e.preventDefault(); // suppress text selection / native scroll while dragging
  }

  function onMove(e: PointerEvent): void {
    const map = opts.getMap();
    if (!armed || !dragStart || !map) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    const p = map.mouseEventToContainerPoint(e);
    updateRubber(p.x, p.y);
    e.preventDefault(); // keep the browser from scrolling/zooming mid-drag (touch)
  }

  function onUp(e: PointerEvent): void {
    const map = opts.getMap();
    if (!armed || !dragStart || !map) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    const start = dragStart;
    const end = map.mouseEventToContainerPoint(e);
    dragStart = null;
    activePointerId = null;
    if (rubberBand) {
      rubberBand.remove();
      rubberBand = null;
    }
    // A real drag selects every ride crossing the box; a stray click selects
    // nothing (and just disarms). Run the box filter once on release.
    if (
      Math.abs(end.x - start.x) >= DRAG_THRESHOLD_PX ||
      Math.abs(end.y - start.y) >= DRAG_THRESHOLD_PX
    ) {
      opts.onSelect(
        ridesInLatLngBox(opts.getTracks(), boxFromCorners(map, start, { x: end.x, y: end.y })),
      );
    }
    // Defer disarming so the trailing Leaflet 'click' is still suppressed by `armed`.
    setTimeout(() => setMode(false), 0);
  }

  function attach(): void {
    if (attached) return;
    const map = opts.getMap();
    if (!map) return;
    attached = true;
    map.on("click", onMapClick);
    const cont = map.getContainer();
    // Pointer events unify mouse + touch + pen so the rubber-band drag works on
    // mobile. With pointer capture (set in onDown) move/up fire on the container
    // even past its edges, so we listen on the container itself, not window.
    cont.addEventListener("pointerdown", onDown);
    cont.addEventListener("pointermove", onMove);
    cont.addEventListener("pointerup", onUp);
    cont.addEventListener("pointercancel", onUp);
  }

  return {
    attach,
    setMode,
    isArmed: () => armed,
  };
}
