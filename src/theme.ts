/**
 * GPX Toolkit — colour theme (dark / light / system).
 *
 * The whole palette lives in CSS custom properties on `:root`; the light theme is
 * one override block keyed on `html[data-theme="light"]`. This module owns the
 * preference (persisted in localStorage), resolves "system" through
 * `prefers-color-scheme`, stamps the resolved theme on `<html>` and keeps the
 * Settings dialog's segmented control in step. The inline boot script in
 * index.html applies the same key before first paint so there's no flash; this
 * module takes over from there.
 *
 * Canvas charts read their colours through `getComputedStyle` at draw time, so a
 * theme switch only needs a re-render — `themechange` is dispatched on `window`
 * for the app to redraw the active view.
 */

export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

const THEME_KEY = "gpx_toolkit.theme";
const THEME_PREFS: readonly ThemePref[] = ["dark", "light", "system"];

const lightQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_PREFS.includes(v as ThemePref) ? (v as ThemePref) : "dark";
  } catch {
    return "dark";
  }
}

/** The concrete theme a preference resolves to right now. */
export function resolveTheme(pref: ThemePref = readThemePref()): Theme {
  if (pref === "system") return lightQuery()?.matches ? "light" : "dark";
  return pref;
}

/** Stamp the resolved theme on <html> and sync the Settings control. */
export function applyTheme(): void {
  const pref = readThemePref();
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  document.querySelectorAll<HTMLButtonElement>("#setTheme [data-theme-pref]").forEach((b) => {
    b.classList.toggle("active", b.dataset.themePref === pref);
  });
  if (changed) window.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
  applyTheme();
}

/** Apply the stored preference and wire the Settings segmented control + the
 *  system-preference listener (only matters while the preference is "system"). */
export function initTheme(): void {
  applyTheme();
  document.getElementById("setTheme")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-pref]");
    if (b) setThemePref(b.dataset.themePref as ThemePref);
  });
  lightQuery()?.addEventListener("change", () => {
    if (readThemePref() === "system") applyTheme();
  });
}
