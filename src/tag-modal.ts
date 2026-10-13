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
import {
  addTag,
  collectTags,
  hasTag,
  normalizeTag,
  removeTag,
  TAG_COLOR_NAMES,
  tagColorCss,
  tagColorStyle,
  tagKey,
} from "./tags";
import { cycleThrough, escHtml } from "./ui";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

export interface TagModalDeps {
  /** The live unified ride list (used to seed chips and read current tags). */
  getRides: () => RideView[];
  /** Commit the computed tag set for each targeted ride uid (Controller.setRideTags). */
  setRideTags: (uids: string[], tagsFor: (uid: string) => string[]) => void;
  /** Tag colours by tag key, and the setter (null clears). A colour belongs to the
   *  tag, not the rides being edited, so it applies at once (not on Save). */
  tagColors: () => Readonly<Record<string, string>>;
  setTagColor: (key: string, color: string | null) => void;
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
      ? `Tags for ${[rides[0].title || "this ride", rideShortLabel(rides[0].date_key)].filter(Boolean).join(", ")}.`
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
      const colored = tagColorStyle(deps.tagColors(), c.name);
      return (
        `<span class="tagmodal-item"><button type="button" class="tagmodal-dot${colored ? " set" : ""}" data-tagcolor="${i}"${colored} aria-label="${escHtml(
          `Colour for ${c.name}`,
        )}" title="Pick a colour for ${escHtml(c.name)}"></button>` +
        `<button type="button" class="tagmodal-chip${cls}" data-tagidx="${i}"${colored} title="${escHtml(
          `${c.name} — ${hint}`,
        )}">${escHtml(c.name)}</button></span>`
      );
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
  closeTagColorPicker();
  state = null;
}

/**
 * The colour picker for one chip: the palette swatches, a custom colour (the native
 * picker) and None, in a small popover under the chip's dot. Picking applies at once.
 */
export function openTagColorPicker(i: number, anchor: HTMLElement): void {
  const chip = state?.chips[i];
  const card = anchor.closest<HTMLElement>(".modal-card");
  if (!chip || !card) return;
  closeTagColorPicker();
  const current = deps.tagColors()[chip.key] ?? "";
  const pop = document.createElement("div");
  pop.className = "tagcolor-pop";
  pop.id = "tagColorPop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", `Colour for ${chip.name}`);
  const custom = /^#/.test(current) ? current : "#3b82f6";
  pop.innerHTML =
    TAG_COLOR_NAMES.map(
      (name) =>
        `<button type="button" class="tagcolor-sw${current === name ? " on" : ""}" data-color="${name}" style="--tc:${tagColorCss(name)}" aria-label="${name}" title="${name[0].toUpperCase()}${name.slice(1)}"></button>`,
    ).join("") +
    `<label class="tagcolor-sw tagcolor-custom${/^#/.test(current) ? " on" : ""}" title="Any colour" style="--tc:${custom}"><input type="color" value="${custom}" aria-label="Custom colour" /></label>` +
    `<button type="button" class="tagcolor-none" data-color="">None</button>`;
  card.append(pop);
  const a = anchor.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(c.width - pop.offsetWidth - 8, a.left - c.left - 6))}px`;
  pop.style.top = `${a.bottom - c.top + 6}px`;
  const apply = (color: string | null): void => {
    deps.setTagColor(chip.key, color);
    renderTagModalChips();
  };
  pop.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-color]");
    if (!b) return;
    apply(b.dataset.color || null);
    closeTagColorPicker();
  });
  pop
    .querySelector<HTMLInputElement>('input[type="color"]')
    ?.addEventListener("change", (e) => {
      apply((e.target as HTMLInputElement).value.toLowerCase());
      closeTagColorPicker();
    });
  // Any press outside the popover (and its dot) closes it.
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
}

function onOutside(e: PointerEvent): void {
  const t = e.target as HTMLElement;
  if (t.closest("#tagColorPop")) return;
  closeTagColorPicker();
}

function closeTagColorPicker(): void {
  document.getElementById("tagColorPop")?.remove();
  document.removeEventListener("pointerdown", onOutside, true);
}
