import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initSegSliding } from "../src/seg";

let resize: ResizeObserverCallback;
const observe = vi.fn();
const unobserve = vi.fn();
const resizeObserver = vi.fn((callback: ResizeObserverCallback) => {
  resize = callback;
  return { observe, unobserve, disconnect: vi.fn() };
});

// MutationObserver delivery and the mutations it creates both settle here.
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", resizeObserver);
  initSegSliding();
});

afterEach(async () => {
  document.body.replaceChildren();
  await settle();
});

function resized(...elements: HTMLElement[]): void {
  resize(
    elements.map((target) => ({
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    })),
    {} as ResizeObserver,
  );
}

async function control(): Promise<{
  seg: HTMLElement;
  buttons: HTMLButtonElement[];
  boxes: { width: number; height: number; left: number; top: number }[];
  thumb: HTMLElement;
}> {
  const seg = document.createElement("div");
  seg.className = "seg";
  seg.innerHTML = '<button class="active">Distance</button><button>Speed</button>';
  const buttons = [...seg.querySelectorAll("button")];
  const boxes = [
    { width: 90, height: 32, left: 0, top: 0 },
    { width: 70, height: 32, left: 90, top: 0 },
  ];
  buttons.forEach((button, i) => {
    Object.defineProperties(button, {
      offsetWidth: { get: () => boxes[i].width },
      offsetHeight: { get: () => boxes[i].height },
      offsetLeft: { get: () => boxes[i].left },
      offsetTop: { get: () => boxes[i].top },
    });
  });
  document.body.append(seg);
  await settle();
  return { seg, buttons, boxes, thumb: seg.querySelector<HTMLElement>(".seg-thumb")! };
}

describe("segmented control motion", () => {
  it("places a new thumb immediately and initializes only once", async () => {
    const { seg, thumb, buttons } = await control();
    initSegSliding();
    expect(resizeObserver).toHaveBeenCalledTimes(1);
    expect(seg.querySelectorAll(".seg-thumb")).toHaveLength(1);
    expect(thumb.classList.contains("no-anim")).toBe(true);
    expect(thumb.style.width).toBe("90px");
    expect(observe).toHaveBeenCalledWith(seg);
    for (const button of buttons) expect(observe).toHaveBeenCalledWith(button);
  });

  it("slides once to the final selection after a batch of class changes", async () => {
    const { seg, buttons, thumb } = await control();
    buttons[0].classList.remove("active");
    buttons[1].classList.add("active");
    await settle();
    expect(thumb.classList.contains("no-anim")).toBe(false);
    expect(thumb.style.transform).toBe("translate(90px, 0px)");
    expect(thumb.style.width).toBe("70px");
    // A resize delivery with the same target geometry must not cancel the slide.
    resized(seg, ...buttons);
    buttons[1].classList.add("busy");
    await settle();
    expect(thumb.classList.contains("no-anim")).toBe(false);
  });

  it("snaps geometry changes with the same selection, even on a class mutation", async () => {
    const { buttons, boxes, thumb } = await control();
    boxes[0].width = 32;
    buttons[0].classList.add("compact");
    await settle();
    expect(thumb.classList.contains("no-anim")).toBe(true);
    expect(thumb.style.width).toBe("32px");
  });

  it("tracks a button resizing inside an unchanged parent without animation", async () => {
    const { buttons, boxes, thumb } = await control();
    boxes[0].width = 110;
    resized(buttons[0]);
    expect(thumb.style.width).toBe("110px");
    expect(thumb.classList.contains("no-anim")).toBe(true);
  });

  it("snaps a hidden control back into view", async () => {
    const { seg, buttons, boxes, thumb } = await control();
    boxes[0].width = 0;
    resized(seg);
    expect(thumb.classList.contains("off")).toBe(true);
    buttons[0].classList.remove("active");
    buttons[1].classList.add("active");
    await settle();
    expect(thumb.classList.contains("off")).toBe(false);
    expect(thumb.classList.contains("no-anim")).toBe(true);
  });

  it("hides the thumb without an active selection and snaps on reselection", async () => {
    const { buttons, thumb } = await control();
    buttons[0].classList.remove("active");
    await settle();
    expect(thumb.classList.contains("off")).toBe(true);
    buttons[1].classList.add("active");
    await settle();
    expect(thumb.classList.contains("no-anim")).toBe(true);
    expect(thumb.classList.contains("off")).toBe(false);
  });

  it("releases detached controls and observes them again on reattachment", async () => {
    const { seg, buttons } = await control();
    seg.remove();
    await settle();
    expect(unobserve).toHaveBeenCalledWith(seg);
    for (const button of buttons) expect(unobserve).toHaveBeenCalledWith(button);
    observe.mockClear();
    document.body.append(seg);
    await settle();
    expect(observe).toHaveBeenCalledWith(seg);
    for (const button of buttons) expect(observe).toHaveBeenCalledWith(button);
  });
});
