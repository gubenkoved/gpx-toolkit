/**
 * GPX Toolkit — tag-assignment modal (bulk-edit ride tags).
 *
 * A tri-state chip per existing tag: "on" = every targeted ride has it, "off" =
 * none does, "mixed" = some do. Clicking a chip that STARTED mixed cycles
 * mixed → on → off → mixed (so "leave as-is" stays reachable); an on/off chip just
 * toggles. On Save we apply exactly what's shown — add the on tags, remove the off
 * tags, leave the mixed ones untouched — so a bulk edit is non-destructive.
 *
 * The modal reads rides through an injected `getRides` and commits via an injected
 * `setRideTags` (the Controller's method), so it never imports app state directly.
 * Its working state (`state`) is module-local and cleared on save/close.
 */

import type { RideView } from "./controller";
import { rideShortLabel } from "./parsing";
import { addTag, collectTags, hasTag, normalizeTag, removeTag, tagKey } from "./tags";
import { cycleThrough, escHtml } from "./ui";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

export interface TagModalDeps {
  /** The live unified ride list (used to seed chips and read current tags). */
  getRides: () => RideView[];
  /** Commit the computed tag set for each targeted ride uid (Controller.setRideTags). */
  setRideTags: (uids: string[], tagsFor: (uid: string) => string[]) => void;
}

let deps: TagModalDeps;
export function initTagModal(d: TagModalDeps): void {
  deps = d;
}

type TagTri = "on" | "off" | "mixed";
interface TagChip {
  name: string;
  key: string;
  initial: TagTri;
  cur: TagTri;
}
let state: { keys: string[]; chips: TagChip[] } | null = null;

/** Open the tag-assign modal for one or more ride uids. */
export function openTagModal(keys: string[]): void {
  const all = deps.getRides();
  const rides = keys
    .map((k) => all.find((r) => r.key === k))
    .filter((r): r is RideView => !!r);
  if (!rides.length) return;
  const chips: TagChip[] = collectTags(all).map((name) => {
    const n = rides.filter((r) => hasTag(r.tags, name)).length;
    const initial: TagTri = n === 0 ? "off" : n === rides.length ? "on" : "mixed";
    return { name, key: tagKey(name), initial, cur: initial };
  });
  state = { keys: rides.map((r) => r.key), chips };
  $("#tagModalBody").textContent =
    rides.length === 1
      ? `Tags for ${rideShortLabel(rides[0].key) || rides[0].key}.`
      : `Tags for ${rides.length} selected rides.`;
  const input = $<HTMLInputElement>("#tagModalInput");
  input.value = "";
  renderTagModalChips();
  document.getElementById("tagModal")?.classList.remove("hidden");
  input.focus();
}

/** Repaint the modal's tag chips from the working state. */
function renderTagModalChips(): void {
  const wrap = document.getElementById("tagModalChips");
  if (!wrap || !state) return;
  wrap.innerHTML = state.chips
    .map((c, i) => {
      const cls = c.cur === "on" ? " on" : c.cur === "mixed" ? " mixed" : "";
      const hint =
        c.cur === "on"
          ? "will be on every ride"
          : c.cur === "mixed"
            ? "left unchanged (on some rides)"
            : "will be removed from every ride";
      return `<button type="button" class="tagmodal-chip${cls}" data-tagidx="${i}" title="${escHtml(
        `${c.name} — ${hint}`,
      )}">${escHtml(c.name)}</button>`;
    })
    .join("");
}

/** Advance a chip's tri-state on click (mixed chips cycle through three states). */
export function cycleTagChip(i: number): void {
  const c = state?.chips[i];
  if (!c) return;
  c.cur =
    c.initial === "mixed"
      ? cycleThrough<TagTri>(["mixed", "on", "off"], c.cur)
      : cycleThrough<TagTri>(["on", "off"], c.cur);
  renderTagModalChips();
}

/** Add a typed tag to the modal (creating its chip), or re-arm an existing one. */
export function addTagModalTag(): void {
  if (!state) return;
  const input = $<HTMLInputElement>("#tagModalInput");
  const disp = normalizeTag(input.value);
  input.value = "";
  input.focus();
  if (!disp) return;
  const key = tagKey(disp);
  const existing = state.chips.find((c) => c.key === key);
  if (existing) existing.cur = "on";
  else state.chips.push({ name: disp, key, initial: "off", cur: "on" });
  renderTagModalChips();
}

/** Apply the modal's choices to every targeted ride and close it. */
export function saveTagModal(): void {
  const st = state;
  document.getElementById("tagModal")?.classList.add("hidden");
  state = null;
  if (!st) return;
  const adds = st.chips.filter((c) => c.cur === "on");
  const removes = st.chips.filter((c) => c.cur === "off");
  const rides = deps.getRides();
  deps.setRideTags(st.keys, (uid) => {
    const ride = rides.find((r) => r.key === uid);
    let next = ride ? [...ride.tags] : [];
    for (const c of removes) next = removeTag(next, c.name);
    for (const c of adds) next = addTag(next, c.name);
    return next;
  });
}

/** Dismiss the tag modal without applying anything. */
export function closeTagModal(): void {
  document.getElementById("tagModal")?.classList.add("hidden");
  state = null;
}
