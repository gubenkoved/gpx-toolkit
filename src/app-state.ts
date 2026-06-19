/**
 * GPX Toolkit — shared app state.
 *
 * The home for state that several views/modules genuinely share, so it lives in
 * one importable place instead of as closures inside the `main.ts` monolith. This
 * is the seam that lets `main.ts` be decomposed into per-view modules: a view
 * imports the shared signals it needs from here (and keeps its own local state in
 * its own module).
 *
 * Built on the tiny reactive core (`./reactive`): shared state is exposed as
 * `signal`s so a view can `effect(() => …)` on it rather than being driven by one
 * global re-render.
 *
 * Start small and grow deliberately — only promote state here once it's actually
 * shared across modules (today: the active top-level view).
 */

import { signal } from "./reactive";

export type ViewName = "explore" | "map" | "stats" | "analytics" | "climate" | "timeline";

const VIEW_KEY = "beeline_uploader.view";

function readView(): ViewName {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "map" ||
      v === "stats" ||
      v === "analytics" ||
      v === "climate" ||
      v === "timeline"
      ? v
      : "explore";
  } catch {
    return "explore";
  }
}

/** The active top-level view (tab). Shared by `main.ts` and the per-view modules. */
export const activeView = signal<ViewName>(readView());

/**
 * Switch the active view and persist the choice. Returns whether it actually
 * changed (callers do their own apply/render side-effects). Persisting is wrapped
 * in try/catch — private mode / disabled storage is non-fatal.
 */
export function setActiveView(v: ViewName): boolean {
  if (v === activeView.peek()) return false;
  activeView.set(v);
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
  return true;
}
