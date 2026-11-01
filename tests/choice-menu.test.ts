import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChoiceMenu, initChoiceMenu } from "../src/choice-menu";

const menus: ChoiceMenu[] = [];
afterEach(() => {
  for (const menu of menus) menu.close();
  menus.length = 0;
  document.body.replaceChildren();
});

function mount(id = "colour") {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = `<select id="${id}" aria-label="Route colour">
    <option value="plain">Plain</option><option value="height" disabled>Elevation</option>
    <option value="speed" selected>Speed</option><option value="wind">Wind</option>
    <option value="other" hidden>Unavailable</option></select>`;
  document.body.append(dialog);
  const select = dialog.querySelector("select")!;
  const choice = initChoiceMenu(select);
  menus.push(choice);
  const trigger = dialog.querySelector<HTMLButtonElement>(`#${id}Choice`)!;
  const menu = dialog.querySelector<HTMLElement>('[role="menu"]')!;
  const row = (value: string) =>
    menu.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  return { dialog, select, choice, trigger, menu, row };
}

function key(value: string) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
  );
}

describe("styled choice menus", () => {
  it("keeps availability and selection in the native model and emits one bubbling change", () => {
    const { dialog, select, trigger, menu, row } = mount();
    const change = vi.fn();
    dialog.addEventListener("change", change);
    expect(select.hidden).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe("Route colour: Speed");
    trigger.click();
    expect(menu.parentElement).toBe(dialog);
    expect(row("speed").getAttribute("aria-checked")).toBe("true");
    expect(row("height").disabled).toBe(true);
    expect(row("other")).toBeNull();
    row("height").click();
    expect(select.value).toBe("speed");
    row("wind").click();
    expect(select.value).toBe("wind");
    expect(change).toHaveBeenCalledOnce();
    expect(trigger.textContent).toBe("Wind");
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    row("wind").click();
    expect(change).toHaveBeenCalledOnce();
  });

  it("navigates enabled choices, supports typeahead, and keeps Escape inside the menu", () => {
    const { select, trigger, menu, row } = mount();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    try {
      trigger.focus();
      key("ArrowDown");
      expect(document.activeElement).toBe(row("speed"));
      key("ArrowUp");
      expect(document.activeElement).toBe(row("plain"));
      key("End");
      expect(document.activeElement).toBe(row("wind"));
      key("Home");
      expect(document.activeElement).toBe(row("plain"));
      key("s");
      expect(document.activeElement).toBe(row("speed"));
      key("Escape");
      expect(menu.hidden).toBe(true);
      expect(select.value).toBe("speed");
      expect(document.activeElement).toBe(trigger);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", outer);
    }
  });

  it("updates asynchronous option changes without losing focus and closes when its field hides", () => {
    const { dialog, select, choice, trigger, menu, row } = mount();
    trigger.click();
    row("wind").focus();
    select.options[1].disabled = false;
    select.value = "plain";
    choice.sync();
    expect(trigger.textContent).toBe("Plain");
    expect(row("height").disabled).toBe(false);
    expect(document.activeElement).toBe(row("wind"));
    select.options[3].hidden = true;
    choice.sync();
    expect(document.activeElement).toBe(row("plain"));
    dialog.classList.add("hidden");
    choice.sync();
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("allows one open menu and dismisses on outside press, Tab and resize", () => {
    const first = mount();
    const second = mount("graph");
    first.trigger.click();
    second.trigger.click();
    expect(first.menu.hidden).toBe(true);
    expect(second.menu.hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(second.menu.hidden).toBe(true);
    first.trigger.click();
    key("Tab");
    expect(first.menu.hidden).toBe(true);
    expect(document.activeElement).toBe(first.trigger);
    second.trigger.click();
    window.dispatchEvent(new Event("resize"));
    expect(second.menu.hidden).toBe(true);
  });
});
