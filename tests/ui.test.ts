import { describe, expect, it } from "vitest";

import { cycleThrough, escHtml, statNum } from "../src/ui";

describe("escHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escHtml(`a & b < c > d "e"`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
  it("is null-safe", () => {
    expect(escHtml(undefined as unknown as string)).toBe("");
  });
});

describe("statNum", () => {
  it("emits the canonical value + label markup", () => {
    expect(statNum({ value: "219 km", label: "total distance" })).toBe(
      '<div class="stat-num">' +
        '<b class="stat-num-v">219 km</b>' +
        '<span class="stat-num-l">total distance</span></div>',
    );
  });

  it("adds the sub-line only when provided", () => {
    const html = statNum({ value: "23 km", label: "biggest ride", sub: "Jun 11 · 1 ride" });
    expect(html).toContain('<span class="stat-num-s">Jun 11 · 1 ride</span>');
    expect(statNum({ value: "x", label: "y" })).not.toContain("stat-num-s");
  });

  it("uses the compact variant for small", () => {
    expect(statNum({ value: "ENE", label: "prevailing", small: true })).toContain(
      '<div class="stat-num stat-num--sm">',
    );
  });

  it("escapes every interpolated field (no XSS via value/label/sub/title)", () => {
    const html = statNum({
      value: `<img src=x onerror=alert(1)>`,
      label: `a & b`,
      sub: `"quoted"`,
      title: `<b>t</b>`,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("a &amp; b");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain('title="&lt;b&gt;t&lt;/b&gt;"');
  });
});

describe("cycleThrough", () => {
  it("advances to the next entry and wraps past the end", () => {
    const order = ["any", "yes", "no"] as const;
    expect(cycleThrough(order, "any")).toBe("yes");
    expect(cycleThrough(order, "yes")).toBe("no");
    expect(cycleThrough(order, "no")).toBe("any");
  });

  it("falls back to the first entry when the current value isn't in the order", () => {
    expect(cycleThrough(["on", "off"], "mixed" as "on" | "off")).toBe("on");
  });
});
