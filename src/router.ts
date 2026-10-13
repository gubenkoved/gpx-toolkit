import type { ViewName } from "./app-state";

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface Route {
  view: ViewName;
  point?: RoutePoint;
  /** Forecast only: a past day (`YYYY-MM-DD`) whose archived runs replace "now". */
  at?: string;
}

/** A real calendar day as `YYYY-MM-DD` (no time, no zone). */
export function validRouteDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const pathToView: Record<string, ViewName> = {
  explore: "explore",
  map: "map",
  stats: "stats",
  analytics: "analytics",
  "wind-rose": "climate",
  forecast: "forecast",
  timeline: "timeline",
  routes: "routes",
};

const viewToPath: Record<ViewName, string> = {
  explore: "explore",
  map: "map",
  stats: "stats",
  analytics: "analytics",
  climate: "wind-rose",
  forecast: "forecast",
  timeline: "timeline",
  routes: "routes",
};

export function validRoutePoint(point: RoutePoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

export function sameRoutePoint(a: RoutePoint | null, b: RoutePoint | null): boolean {
  return (
    !!a &&
    !!b &&
    a.lat.toFixed(6) === b.lat.toFixed(6) &&
    a.lon.toFixed(6) === b.lon.toFixed(6)
  );
}

/** A missing or malformed route returns null so the caller can restore local state. */
export function parseRoute(hash: string): Route | null {
  if (!hash.startsWith("#/")) return null;
  const [path, query, ...extra] = hash.slice(2).split("?");
  if (extra.length) return null;
  const view = pathToView[path];
  if (!view) return null;
  if (query === undefined || query === "") return { view };
  if (view !== "forecast" && view !== "climate") return null;
  const params = new URLSearchParams(query);
  const at = params.get("at");
  if (at != null && (view !== "forecast" || !validRouteDay(at))) return null;
  if (params.size !== (at == null ? 2 : 3) || !params.has("lat") || !params.has("lon"))
    return null;
  const latText = params.get("lat")!;
  const lonText = params.get("lon")!;
  if (!latText.trim() || !lonText.trim()) return null;
  const point = { lat: Number(latText), lon: Number(lonText) };
  if (!validRoutePoint(point)) return null;
  return at == null ? { view, point } : { view, point, at };
}

export function formatRoute(route: Route): string {
  const hash = `#/${viewToPath[route.view]}`;
  if (!route.point || (route.view !== "forecast" && route.view !== "climate")) return hash;
  if (!validRoutePoint(route.point)) throw new RangeError("Invalid route point");
  const at = route.view === "forecast" && route.at ? `&at=${route.at}` : "";
  return `${hash}?lat=${route.point.lat.toFixed(6)}&lon=${route.point.lon.toFixed(6)}${at}`;
}

export function writeRoute(route: Route, mode: "push" | "replace"): void {
  const hash = formatRoute(route);
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](
    window.history.state,
    "",
    url,
  );
}
