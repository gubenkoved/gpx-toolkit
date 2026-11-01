import { afterEach, describe, expect, it } from "vitest";
import { autoFold, refold } from "../src/fold";

afterEach(() => document.body.replaceChildren());

describe("toolbar folding", () => {
  function toolbar(fitsAt: number | null): {
    el: HTMLElement;
    button: HTMLButtonElement;
    commits: { level: number; transition: string }[];
  } {
    const el = document.createElement("div");
    const button = document.createElement("button");
    button.style.transition = "color 0.12s ease";
    el.append(button);
    document.body.append(el);
    const level = (): number =>
      el.classList.contains("fold-2") ? 2 : el.classList.contains("fold-1") ? 1 : 0;
    const commits: { level: number; transition: string }[] = [];
    Object.defineProperties(el, {
      getClientRects: { value: () => [{}] },
      clientWidth: { value: 100 },
      scrollWidth: { get: () => (fitsAt !== null && level() >= fitsAt ? 100 : 200) },
      offsetWidth: {
        get: () => {
          commits.push({ level: level(), transition: button.style.transition });
          return 100;
        },
      },
    });
    return { el, button, commits };
  }

  it("commits full labels without transitions when no fold avoids the wrap", () => {
    const { el, button, commits } = toolbar(null);
    autoFold(el, 2);
    refold(el);
    expect(el.className).toBe("");
    expect(commits).toEqual([
      { level: 0, transition: "none" },
      { level: 0, transition: "none" },
    ]);
    expect(button.style.transition).toBe("color 0.12s ease");
  });

  it("commits the mildest fitting fold before restoring transitions", () => {
    const { el, button, commits } = toolbar(1);
    autoFold(el, 2);
    expect(el.className).toBe("fold-1");
    expect(commits).toEqual([{ level: 1, transition: "none" }]);
    expect(button.style.transition).toBe("color 0.12s ease");
  });
});
