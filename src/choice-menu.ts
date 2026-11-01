/**
 * Styled single-choice menus using the app's split-button and flat menu rows.
 * The hidden select remains the value/availability model and emits the same change
 * event as before. Call sync after changing its options or value programmatically.
 */
import { icon } from "./icons";

export interface ChoiceMenu {
  sync: () => void;
  close: () => void;
}

let closeActive: (() => void) | null = null;

export function initChoiceMenu(select: HTMLSelectElement): ChoiceMenu {
  const wrapper = document.createElement("span");
  wrapper.className = "split choice-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `${select.id}Choice`;
  trigger.className = "small menubtn";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const value = document.createElement("span");
  trigger.append(value);
  const menu = document.createElement("div");
  menu.id = `${select.id}Menu`;
  menu.className = "splitmenu choice-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", select.getAttribute("aria-label") || select.id);
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  select.before(wrapper);
  wrapper.append(select, trigger);
  select.hidden = true;
  // Stay inside the modal's accessible subtree, above its map's Leaflet panes.
  (select.closest('[role="dialog"]') ?? document.body).append(menu);

  let search = "";
  let searchAt = 0;
  const items = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));

  function close(restoreFocus = false): void {
    menu.hidden = true;
    wrapper.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onLayout);
    document.removeEventListener("scroll", onLayout, true);
    if (closeActive === close) closeActive = null;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function position(): void {
    const anchor = trigger.getBoundingClientRect();
    const gap = 6;
    menu.style.minWidth = `${anchor.width}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(gap, Math.min(anchor.left, innerWidth - rect.width - gap))}px`;
    const top =
      anchor.bottom + gap + rect.height <= innerHeight
        ? anchor.bottom + gap
        : anchor.top - rect.height - gap;
    menu.style.top = `${Math.max(gap, top)}px`;
  }

  function render(): void {
    const focused = menu.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.value
      : null;
    menu.replaceChildren();
    for (const option of select.options) {
      if (option.hidden) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(option.selected));
      row.dataset.value = option.value;
      row.disabled = option.disabled;
      row.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = option.label;
      row.append(label);
      row.insertAdjacentHTML("beforeend", icon("check"));
      row.addEventListener("click", () => {
        if (row.disabled) return;
        close(true);
        if (select.value !== option.value) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        sync();
      });
      menu.append(row);
    }
    if (focused != null) {
      const next =
        items().find((row) => row.dataset.value === focused) ??
        items().find((row) => row.getAttribute("aria-checked") === "true") ??
        items()[0];
      next?.focus({ preventScroll: true });
    }
    position();
  }

  function sync(): void {
    const text = select.selectedOptions[0]?.label ?? "";
    value.textContent = text;
    trigger.setAttribute(
      "aria-label",
      `${select.getAttribute("aria-label") || select.id}: ${text}`,
    );
    trigger.disabled = select.disabled;
    if (!menu.hidden) {
      if (trigger.disabled || trigger.closest(".hidden, [hidden]")) close();
      else render();
    }
  }

  function open(edge?: "first" | "last"): void {
    if (trigger.disabled) return;
    closeActive?.();
    closeActive = close;
    menu.hidden = false;
    wrapper.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    search = "";
    render();
    const enabled = items();
    const initial =
      edge === "first"
        ? enabled[0]
        : edge === "last"
          ? enabled.at(-1)
          : (enabled.find((row) => row.getAttribute("aria-checked") === "true") ?? enabled[0]);
    initial?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onLayout);
    document.addEventListener("scroll", onLayout, true);
  }

  function outside(event: Event): void {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) close();
  }

  function onFocus(event: FocusEvent): void {
    outside(event);
  }

  function onLayout(event: Event): void {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) {
      close(menu.contains(document.activeElement));
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // dismiss the menu, not the containing ride dialog
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true); // continue the normal tab order from the trigger
      return;
    }
    const enabled = items();
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled.at(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      next =
        enabled[
          (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length
        ];
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      search =
        now - searchAt < 500 ? search + event.key.toLowerCase() : event.key.toLowerCase();
      searchAt = now;
      next = enabled.find((row) => row.textContent?.trim().toLowerCase().startsWith(search));
    } else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus({ preventScroll: true });
    next?.scrollIntoView?.({ block: "nearest" });
  }

  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    open(event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined);
  });
  select.addEventListener("change", sync);
  sync();
  return { sync, close };
}
