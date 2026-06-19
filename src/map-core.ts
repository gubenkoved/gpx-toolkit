/**
 * GPX Toolkit — shared map core.
 *
 * The connective tissue every big interactive Leaflet map in the app reuses, lifted
 * out of `main.ts` so the Map view, the Stats route-frequency heatmap (and, via their
 * injected `osmAttribution`, the Timeline and Wind-rose maps) all speak one basemap
 * vocabulary instead of each re-deriving it:
 *   - one canonical OSM tile-usage credit string,
 *   - one factory for "a big interactive map" — dark desaturated OSM basemap, compact
 *     credit, sane world default — so the look is identical and defined once,
 *   - one builder for the pseudo-fullscreen expand toggle the Map and heatmap share.
 *
 * View-specific machinery (track layers, the heat layer, area-select wiring, side
 * panels) stays with each view; this module owns only what's genuinely common.
 */

import L from "leaflet";

/**
 * OSM's tile usage policy requires a visible "© OpenStreetMap contributors" credit
 * wherever the tiles are shown. One canonical string, reused by every tile layer.
 * The big interactive maps render it as a compact Leaflet control (with
 * `setPrefix(false)` to drop the "Leaflet" flag); the per-ride mini-maps omit the
 * control entirely and lean on the page-level header credit instead, so the badge
 * doesn't repeat on every little card.
 */
export const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/**
 * How close (in screen px) a click must land to "hit" a track. A fingertip is far
 * less precise than a mouse, so coarse (touch) pointers get a much larger radius.
 * Shared by the Map view's and the Stats heatmap's area-select gestures.
 */
export const CLICK_PX =
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 22 : 8;

/** Highlight style for an emphasized track — the Map view's selection/hover and the
 *  Stats heatmap's hover overlay both use it so a lit-up route looks the same. */
export const HOT_TRACK = { color: "#ffe066", weight: 6, opacity: 1 } as const;

export interface InteractiveMapOpts {
  /**
   * Render features onto a single `<canvas>` instead of one SVG `<path>` each. At
   * thousands of overlapping tracks the SVG DOM is the bottleneck; the translucent
   * strokes still blend on canvas, so the "ridden more = brighter" look is preserved
   * and pan/zoom stays smooth. Used by the Map view, not the heatmap.
   */
  preferCanvas?: boolean;
}

/**
 * Create one of the app's big interactive maps: zoom + a compact attribution control,
 * the dark desaturated OSM basemap (`map-tiles`, styled in CSS), and a world-view
 * default until the caller fits real bounds. The caller adds its own layers,
 * area-select and event handlers.
 */
export function createInteractiveMap(host: HTMLElement, opts: InteractiveMapOpts = {}): L.Map {
  const map = L.map(host, {
    attributionControl: true,
    zoomControl: true,
    fadeAnimation: false,
    ...(opts.preferCanvas ? { preferCanvas: true } : {}),
  });
  map.attributionControl.setPrefix(false); // compact credit, no "Leaflet" flag
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: OSM_ATTRIBUTION,
    className: "map-tiles",
  }).addTo(map);
  map.setView([20, 0], 2); // sane default until the first track is drawn
  return map;
}

/**
 * Build a pseudo-fullscreen toggle for a map (the CSS `position:fixed` pattern, not
 * the Fullscreen API): flips a body class, reflects the state on its icon-only button
 * (`aria-pressed`, which CSS uses to swap maximize↔minimize), and nudges Leaflet to
 * re-measure after the container resizes. The Map view and the Stats heatmap each get
 * one of these so they expand identically.
 */
export function makeExpandToggle(
  bodyClass: string,
  buttonId: string,
  getMap: () => L.Map | null,
): (on: boolean) => void {
  return (on: boolean) => {
    document.body.classList.toggle(bodyClass, on);
    document.getElementById(buttonId)?.setAttribute("aria-pressed", on ? "true" : "false");
    requestAnimationFrame(() => getMap()?.invalidateSize());
  };
}
