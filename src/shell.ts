/**
 * GPX Toolkit — app shell: the grouped sidebar (desktop), the bottom nav + "More"
 * sheet (phones) and the per-view top bar.
 *
 * One set of navigation elements, never two copies: every nav control is a
 * `.navlink[data-view]` and the global click dispatcher in main.ts routes any
 * `data-view` click through `setView`. This module only (1) reflects the active
 * view onto those links + the top-bar title, (2) owns the sidebar's rail/expanded
 * toggle, (3) opens/closes the phone "More" sheet, and (4) on phones *moves* the
 * sidebar's Research group and footer (Sources / Settings / connection state) into
 * that sheet — the same DOM nodes, re-parented on a media-query flip, so ids stay
 * unique and nothing is rendered twice. (The live activity tile stays at body level:
 * it is a fixed strip along the bottom of the main pane on every width.)
 */

import { activeView, type ViewName } from "./app-state";

/** Human titles for the top bar. */
export const VIEW_TITLES: Record<ViewName, string> = {
  explore: "Explore",
  map: "Map",
  stats: "Stats",
  analytics: "Wind vs speed",
  climate: "Wind rose",
  forecast: "Forecast",
  timeline: "Timeline",
};

/** The two Weather views share one bottom-nav slot on phones. */
const WEATHER_VIEWS: readonly ViewName[] = ["forecast", "climate"];
const WEATHER_KEY = "gpx_toolkit.weather_view";
const RAIL_KEY = "gpx_toolkit.sidebar_rail";
const PHONE = "(max-width: 768px)";

let phoneQuery: MediaQueryList | null = null;

/** Last-used Weather view, so the bottom-nav "Weather" tap lands where you were. */
export function lastWeatherView(): ViewName {
  try {
    const v = localStorage.getItem(WEATHER_KEY);
    return v === "climate" ? "climate" : "forecast";
  } catch {
    return "forecast";
  }
}

function rememberWeatherView(v: ViewName): void {
  if (!WEATHER_VIEWS.includes(v)) return;
  try {
    localStorage.setItem(WEATHER_KEY, v);
  } catch {
    /* non-fatal */
  }
}

/** Reflect the active view: nav highlights, top-bar title, Weather switch, sheet. */
export function syncShell(): void {
  const view = activeView();
  rememberWeatherView(view);
  document.querySelectorAll<HTMLElement>(".navlink[data-view]").forEach((el) => {
    const on = el.dataset.view === view;
    el.classList.toggle("active", on);
    el.setAttribute("aria-current", on ? "page" : "false");
  });
  const weather = WEATHER_VIEWS.includes(view);
  document.getElementById("navWeather")?.classList.toggle("active", weather);
  document.getElementById("weatherSeg")?.classList.toggle("hidden", !weather);
  const title = document.getElementById("viewTitle");
  if (title) title.textContent = VIEW_TITLES[view];
  // Picking a destination inside the sheet navigates away from it.
  setMoreSheet(false);
}

/** Set a contextual subtitle next to the view title ("" hides it). */
export function setViewSubtitle(text: string): void {
  const el = document.getElementById("viewSub");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("hidden", text === "");
}

export function setMoreSheet(open: boolean): void {
  const sheet = document.getElementById("moreSheet");
  const btn = document.getElementById("btnMore");
  if (!sheet) return;
  sheet.classList.toggle("hidden", !open);
  btn?.setAttribute("aria-expanded", String(open));
  btn?.classList.toggle("active", open);
}

export function isMoreSheetOpen(): boolean {
  return !document.getElementById("moreSheet")?.classList.contains("hidden");
}

function setRail(rail: boolean): void {
  document.body.classList.toggle("sb-rail", rail);
  const btn = document.getElementById("btnSidebar");
  btn?.setAttribute("aria-expanded", String(!rail));
  btn?.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
  btn?.setAttribute("title", rail ? "Expand sidebar" : "Collapse sidebar");
  try {
    localStorage.setItem(RAIL_KEY, rail ? "1" : "0");
  } catch {
    /* non-fatal */
  }
}

/** Re-parent the Research group + footer between the sidebar and the phone sheet. */
function placeSharedNav(): void {
  const phone = !!phoneQuery?.matches;
  const research = document.getElementById("sbResearch");
  const foot = document.getElementById("sbFoot");
  const sidebarNav = document.getElementById("viewTabs");
  const sidebar = document.getElementById("sidebar");
  const sheetBody = document.getElementById("moreBody");
  if (!research || !foot || !sidebarNav || !sidebar || !sheetBody) return;
  if (phone) {
    sheetBody.append(research, foot);
  } else {
    sidebarNav.append(research);
    sidebar.append(foot);
    setMoreSheet(false);
  }
}

export function initShell(): void {
  let rail = false;
  try {
    rail = localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    /* non-fatal */
  }
  setRail(rail);
  document.getElementById("btnSidebar")?.addEventListener("click", () => {
    setRail(!document.body.classList.contains("sb-rail"));
  });
  document.getElementById("btnMore")?.addEventListener("click", () => {
    setMoreSheet(!isMoreSheetOpen());
  });
  document.getElementById("moreClose")?.addEventListener("click", () => setMoreSheet(false));
  document.getElementById("moreSheet")?.addEventListener("click", (e) => {
    // Tap the scrim to dismiss; choosing anything inside also closes the sheet —
    // the destination (a view, the Sources or Settings dialog) takes over.
    const t = e.target as HTMLElement;
    if (e.target === e.currentTarget || t.closest("button")) setMoreSheet(false);
  });
  phoneQuery = typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : null;
  phoneQuery?.addEventListener("change", placeSharedNav);
  placeSharedNav();
  syncShell();
}
