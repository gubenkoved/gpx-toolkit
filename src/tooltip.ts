/**
 * GPX Toolkit — the app's one tooltip.
 *
 * Replaces the browser's native `title` bubble (slow, unstyled, unthemed) with a lean
 * card that follows the app's tokens. Two ways in:
 *
 *  - any element with a `title` (or `data-tip`) gets it on hover / keyboard focus. The
 *    `title` is moved to `data-tip` the moment the pointer arrives, so the native bubble
 *    never shows; its text stays available to assistive tech (`aria-label` on a bare
 *    icon button, `aria-description` otherwise). Code may keep setting `title` — the
 *    next hover picks the new text up.
 *  - charts call `showTip(x, y, content)` / `hideTip()` with rich content (a title,
 *    label · value rows, a muted note) for what is under the pointer.
 *
 * One element, positioned above its anchor (below when there is no room), clamped to
 * the viewport. Hover tips wait a beat; moving straight on to the next target shows it
 * at once. Touch never gets hover tips (a tap is an action); charts decide for themselves.
 */

export interface TipContent {
  title?: string;
  rows?: ReadonlyArray<readonly [label: string, value: string]>;
  note?: string;
}

const SHOW_DELAY_MS = 380;
/** After a tip hides, the next one within this window shows without the delay. */
const WARM_MS = 600;
const GAP = 8;
const EDGE = 8;

let tip: HTMLDivElement | null = null;
let owner: Element | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenAt = 0;

function el(): HTMLDivElement {
  if (tip?.isConnected) return tip;
  // Created on first use; re-attached if something cleared the body since.
  if (tip) {
    document.body.append(tip);
    return tip;
  }
  tip = document.createElement("div");
  tip.id = "appTip";
  tip.className = "app-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** A plain tip's text: a first line ending in ":" or followed by more lines is a heading. */
function render(content: string | TipContent): string {
  if (typeof content === "string") {
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length < 2) return `<div class="app-tip-text">${esc(content)}</div>`;
    return (
      `<div class="app-tip-title">${esc(lines[0])}</div>` +
      lines
        .slice(1)
        .map((line) => `<div class="app-tip-text">${esc(line)}</div>`)
        .join("")
    );
  }
  return (
    (content.title ? `<div class="app-tip-title">${esc(content.title)}</div>` : "") +
    (content.rows?.length
      ? `<dl class="app-tip-rows">${content.rows
          .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
          .join("")}</dl>`
      : "") +
    (content.note ? `<div class="app-tip-note">${esc(content.note)}</div>` : "")
  );
}

/** Place the tip centred over the anchor box (below it when the top has no room). */
function place(box: Box): void {
  const t = el();
  // Measure the card as laid out (still transparent until `reveal`), not as hidden.
  t.hidden = false;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const cx = (box.left + box.right) / 2;
  const left = Math.round(Math.min(vw - EDGE - w, Math.max(EDGE, cx - w / 2)));
  const above = box.top - GAP - h;
  const below = box.bottom + GAP;
  const flip = above < EDGE && below + h <= vh - EDGE;
  const top = Math.round(flip ? below : Math.max(EDGE, above));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
  t.dataset.side = flip ? "below" : "above";
  // The little arrow points at the anchor even when the card was clamped sideways.
  t.style.setProperty(
    "--tip-arrow-x",
    `${Math.round(Math.min(w - 12, Math.max(12, cx - left)))}px`,
  );
}

function reveal(): void {
  const t = el();
  t.hidden = false;
  // Next frame: let the fade start from the hidden state.
  requestAnimationFrame(() => t.classList.add("on"));
}

/** Show rich content at a point (a chart's hover): the tip sits just above it. */
export function showTip(
  x: number,
  y: number,
  content: TipContent | string,
  from: Element | null = null,
): void {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  owner = from;
  const t = el();
  t.innerHTML = render(content);
  t.classList.add("rich");
  place({ left: x, right: x, top: y, bottom: y });
  reveal();
}

export function hideTip(from?: Element | null): void {
  if (from !== undefined && from !== owner) return;
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  if (!tip || tip.hidden) return;
  owner = null;
  tip.classList.remove("on", "rich");
  tip.hidden = true;
  hiddenAt = Date.now();
}

/** Move a native `title` into `data-tip`, keeping its text for assistive tech. */
function adopt(target: Element): string | null {
  const title = target.getAttribute("title");
  if (title != null) {
    target.removeAttribute("title");
    if (title.trim()) {
      target.setAttribute("data-tip", title);
      const named =
        target.hasAttribute("aria-label") || target.hasAttribute("aria-labelledby");
      const text = (target.textContent ?? "").trim();
      if (!named && !text) target.setAttribute("aria-label", title);
      else if (!named || target.getAttribute("aria-label") !== title)
        target.setAttribute("aria-description", title);
    } else target.removeAttribute("data-tip");
  }
  const tipText = target.getAttribute("data-tip");
  return tipText?.trim() ? tipText : null;
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Where a hovered element's tip points: its box — or, for a box-less element (a
 *  `display: contents` wrapper such as a form row's label), the box of its contents;
 *  a big target (a map, a chart) at the pointer. Null when there is nothing on screen
 *  to point at: better no tip than one stranded in the corner. */
function anchorFor(target: Element, pointer: { x: number; y: number } | null): Box | null {
  let r: Box = target.getBoundingClientRect();
  if (r.right - r.left === 0 && r.bottom - r.top === 0) {
    const range = document.createRange();
    range.selectNodeContents(target);
    // (Older DOMs lack Range geometry: the pointer fallback below covers them.)
    if (typeof range.getBoundingClientRect === "function") r = range.getBoundingClientRect();
  }
  const empty = r.right - r.left === 0 && r.bottom - r.top === 0;
  const atPointer = pointer
    ? { left: pointer.x, right: pointer.x, top: pointer.y - 6, bottom: pointer.y + 18 }
    : null;
  if (empty) return atPointer;
  if (atPointer && (r.bottom - r.top > 72 || r.right - r.left > 420)) return atPointer;
  return r;
}

function schedule(target: Element, pointer: { x: number; y: number } | null): void {
  const text = adopt(target);
  if (!text) return;
  if (owner === target && tip && !tip.hidden) return;
  if (showTimer) clearTimeout(showTimer);
  const warm = (tip && !tip.hidden) || Date.now() - hiddenAt < WARM_MS;
  const go = (): void => {
    showTimer = null;
    if (!target.isConnected) return;
    const anchor = anchorFor(target, pointer);
    if (!anchor) return;
    owner = target;
    const t = el();
    t.classList.remove("rich");
    t.innerHTML = render(text);
    place(anchor);
    reveal();
  };
  if (warm) go();
  else showTimer = setTimeout(go, SHOW_DELAY_MS);
}

const TIPPED = "[title], [data-tip]";

export function initTooltips(): void {
  document.addEventListener(
    "pointerover",
    (event) => {
      const target = (event.target as Element | null)?.closest?.(TIPPED);
      if (!target) return;
      // Even on touch the native bubble must not appear — adopt the title, show nothing.
      if (event.pointerType === "touch") {
        adopt(target);
        return;
      }
      // A held modifier means a range / toggle pick is under way: no hint over it.
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        adopt(target);
        return;
      }
      schedule(target, { x: event.clientX, y: event.clientY });
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      const from = (event.target as Element | null)?.closest?.(TIPPED);
      if (!from) return;
      const to = (event.relatedTarget as Element | null)?.closest?.(TIPPED);
      if (to === from) return;
      if (showTimer) clearTimeout(showTimer);
      showTimer = null;
      hideTip(from);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (event) => {
      const target = (event.target as Element | null)?.closest?.(TIPPED);
      if (!target || !(target as HTMLElement).matches?.(":focus-visible")) return;
      schedule(target, null);
    },
    true,
  );
  document.addEventListener("focusout", (event) => hideTip(event.target as Element), true);
  // Anything that moves or acts hides it: it must never sit stale over the page.
  document.addEventListener("pointerdown", () => hideTip(), true);
  document.addEventListener("scroll", () => hideTip(), true);
  window.addEventListener("blur", () => hideTip());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTip();
  });
}
