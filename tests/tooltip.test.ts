import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hideTip, initTooltips, showTip } from "../src/tooltip";

beforeAll(() => initTooltips());

afterEach(() => {
  hideTip();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const tip = (): HTMLElement => document.getElementById("appTip")!;

function hover(target: Element): void {
  // The test DOM has no PointerEvent: a mouse event carrying its pointerType will do.
  const event = new MouseEvent("pointerover", { bubbles: true, clientX: 10, clientY: 10 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

describe("app tooltip", () => {
  it("adopts a title so the native bubble never shows, and keeps it for assistive tech", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      `<button id="icon" title="Refresh forecast"></button>` +
      `<button id="text" title="Moving time, no stops">Ride time</button>`;
    const iconBtn = document.getElementById("icon")!;
    hover(iconBtn);
    expect(iconBtn.hasAttribute("title")).toBe(false);
    expect(iconBtn.getAttribute("data-tip")).toBe("Refresh forecast");
    expect(iconBtn.getAttribute("aria-label")).toBe("Refresh forecast");
    vi.advanceTimersByTime(400);
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe("Refresh forecast");

    const textBtn = document.getElementById("text")!;
    hover(textBtn);
    expect(textBtn.getAttribute("aria-description")).toBe("Moving time, no stops");
    expect(textBtn.hasAttribute("aria-label")).toBe(false);
  });

  it("picks up a title the code sets again later", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button id="b" title="First"></button>`;
    const b = document.getElementById("b")!;
    hover(b);
    b.setAttribute("title", "Second");
    hideTip();
    vi.advanceTimersByTime(1000);
    hover(b);
    vi.advanceTimersByTime(400);
    expect(tip().textContent).toBe("Second");
  });

  it("renders a heading line, rows and a note, escaped", () => {
    showTip(100, 100, {
      title: "Leave <07:00>",
      rows: [["Ride time", "16h 45m"]],
      note: "Click to pick.",
    });
    expect(tip().hidden).toBe(false);
    expect(tip().querySelector(".app-tip-title")?.textContent).toBe("Leave <07:00>");
    expect(tip().innerHTML).not.toContain("<07:00>");
    expect(tip().querySelector("dt")?.textContent).toBe("Ride time");
    expect(tip().querySelector("dd")?.textContent).toBe("16h 45m");
    expect(tip().querySelector(".app-tip-note")?.textContent).toBe("Click to pick.");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip().hidden).toBe(true);
  });

  it("only hides a chart tip for its owner", () => {
    const a = document.createElement("canvas");
    const b = document.createElement("canvas");
    showTip(10, 10, "A", a);
    hideTip(b);
    expect(tip().hidden).toBe(false);
    hideTip(a);
    expect(tip().hidden).toBe(true);
  });
});
