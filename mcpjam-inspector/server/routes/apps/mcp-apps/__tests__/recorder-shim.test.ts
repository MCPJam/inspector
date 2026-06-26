/** @vitest-environment jsdom */
/// <reference lib="dom" />
import { describe, expect, it, vi } from "vitest";
import {
  RECORDER_SHIM_JS,
  eventToStep,
  generateLocator,
  resolveLocator,
  runReplayStep,
} from "../recorder-shim";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("generateLocator", () => {
  it("prefers data-testid", () => {
    mount(`<button data-testid="save" role="button">Save</button>`);
    const el = document.querySelector("button")!;
    expect(generateLocator(el)).toEqual({ testId: "save" });
  });

  it("adds nth when a testId is non-unique, and the locator resolves back", () => {
    mount(
      `<div data-testid="row"></div><div data-testid="row" id="second"></div>`
    );
    const second = document.getElementById("second")!;
    const loc = generateLocator(second);
    expect(loc.testId).toBe("row");
    expect(loc.nth).toBe(1);
    // resolve-back: the locator uniquely identifies the element.
    const matches = document.querySelectorAll(`[data-testid="row"]`);
    expect(matches[loc.nth!]).toBe(second);
  });

  it("falls back to ARIA role + accessible name", () => {
    mount(`<button>Submit</button>`);
    const el = document.querySelector("button")!;
    expect(generateLocator(el)).toEqual({
      role: { role: "button", name: "Submit" },
    });
  });

  it("uses an explicit role and aria-label over text", () => {
    mount(`<div role="link" aria-label="Home">x</div>`);
    const el = document.querySelector("div")!;
    expect(generateLocator(el)).toEqual({
      role: { role: "link", name: "Home" },
    });
  });

  it("treats <a href> as a link role", () => {
    mount(`<a href="/x">Docs</a>`);
    const el = document.querySelector("a")!;
    expect(generateLocator(el)).toEqual({
      role: { role: "link", name: "Docs" },
    });
  });

  it("falls back to visible text for a non-role element", () => {
    mount(`<span>Hello world</span>`);
    const el = document.querySelector("span")!;
    expect(generateLocator(el)).toEqual({ text: "Hello world" });
  });

  it("falls back to a CSS path that resolves back to the element", () => {
    mount(`<section><i></i><i></i><i id="t"></i></section>`);
    const el = document.getElementById("t")!;
    const loc = generateLocator(el);
    expect(loc.css).toBeTruthy();
    // CSS resolves uniquely (id short-circuit) → no nth needed.
    expect(document.querySelector(loc.css!)).toBe(el);
  });

  // Generate-and-verify: every emitted locator must re-select the EXACT element
  // it was generated from. Ambiguous role/text candidates are rejected in favor
  // of the unique CSS path — no element-type heuristics. (Draft.)
  it("rejects a duplicate-named role candidate and emits a locator that round-trips", () => {
    mount(`<button>Save</button><button>Save</button>`);
    const second = document.querySelectorAll("button")[1]!;
    const loc = generateLocator(second);
    // role+name="Save" is ambiguous (resolves to the FIRST button), so it must
    // not be emitted bare; whatever we emit re-selects the SECOND button.
    expect(resolveLocator(loc)).toBe(second);
    expect(resolveLocator({ role: { role: "button", name: "Save" } })).not.toBe(
      second
    );
  });

  it("rejects an ambiguous text candidate and emits a locator that round-trips", () => {
    mount(`<div><span>Go</span></div><div><span id="t">Go</span></div>`);
    const second = document.getElementById("t")!;
    const loc = generateLocator(second);
    expect(resolveLocator(loc)).toBe(second);
    // Proves the bare text locator alone would mis-resolve.
    expect(resolveLocator({ text: "Go" })).not.toBe(second);
  });

  it("emits text when it uniquely identifies the element (round-trips)", () => {
    mount(`<span>Hello world</span>`);
    const el = document.querySelector("span")!;
    const loc = generateLocator(el);
    expect(loc).toEqual({ text: "Hello world" });
    expect(resolveLocator(loc)).toBe(el);
  });
});

describe("eventToStep", () => {
  it("maps a click to a click step", () => {
    mount(`<button data-testid="go">Go</button>`);
    const el = document.querySelector("button")!;
    const step = eventToStep({ type: "click", target: el } as unknown as Event);
    expect(step).toEqual({ kind: "click", target: { testId: "go" } });
  });

  it("maps an input change to a type step with the value", () => {
    mount(`<input data-testid="name" />`);
    const el = document.querySelector("input")! as HTMLInputElement;
    el.value = "Ada";
    const step = eventToStep({
      type: "change",
      target: el,
    } as unknown as Event);
    expect(step).toEqual({
      kind: "type",
      target: { testId: "name" },
      text: "Ada",
    });
  });

  it("ignores non-recordable events", () => {
    mount(`<div>x</div>`);
    const el = document.querySelector("div")!;
    expect(
      eventToStep({ type: "mouseover", target: el } as unknown as Event)
    ).toBeNull();
  });
});

describe("resolveLocator (inverse of generateLocator)", () => {
  // The strongest guarantee: a locator recorded from an element resolves back to
  // that exact element. Covers every priority tier + nth.
  const roundTripCases: Array<{ name: string; html: string; pick: string }> = [
    {
      name: "testId",
      html: `<button data-testid="save">Save</button>`,
      pick: "button",
    },
    { name: "role+name", html: `<button>Submit</button>`, pick: "button" },
    {
      name: "explicit role + aria-label",
      html: `<div role="link" aria-label="Home">x</div>`,
      pick: "div",
    },
    { name: "anchor link", html: `<a href="/x">Docs</a>`, pick: "a" },
    { name: "visible text", html: `<span>Hello world</span>`, pick: "span" },
    {
      name: "css path",
      html: `<section><i></i><i></i><i id="t"></i></section>`,
      pick: "#t",
    },
  ];
  for (const { name, html, pick } of roundTripCases) {
    it(`round-trips via ${name}`, () => {
      mount(html);
      const el = document.querySelector(pick)!;
      const loc = generateLocator(el);
      expect(resolveLocator(loc)).toBe(el);
    });
  }

  it("honors nth for non-unique testId", () => {
    mount(
      `<div data-testid="row"></div><div data-testid="row" id="second"></div>`
    );
    const second = document.getElementById("second")!;
    const loc = generateLocator(second);
    expect(resolveLocator(loc)).toBe(second);
  });

  it("returns null when nothing matches", () => {
    mount(`<button data-testid="a">A</button>`);
    expect(resolveLocator({ testId: "missing" })).toBeNull();
  });

  it("resolves the smallest element for a text locator", () => {
    mount(`<div>wrap <button>Add to cart</button></div>`);
    const btn = document.querySelector("button")!;
    expect(resolveLocator({ text: "Add to cart" })).toBe(btn);
  });
});

describe("runReplayStep", () => {
  it("clicks the resolved element", async () => {
    mount(`<button data-testid="go">Go</button>`);
    const btn = document.querySelector("button")! as HTMLButtonElement;
    let clicked = 0;
    btn.addEventListener("click", () => (clicked += 1));
    const result = await runReplayStep({
      kind: "click",
      target: { testId: "go" },
    });
    expect(result.ok).toBe(true);
    expect(clicked).toBe(1);
  });

  it("fails a click when the element is absent", async () => {
    mount(`<div></div>`);
    const result = await runReplayStep({
      kind: "click",
      target: { testId: "nope" },
    });
    expect(result).toEqual({ ok: false, reason: "element not found" });
  });

  it("types into an input and fires input + change", async () => {
    mount(`<input data-testid="q" />`);
    const input = document.querySelector("input")! as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    const result = await runReplayStep({
      kind: "type",
      target: { testId: "q" },
      text: "coke",
    });
    expect(result.ok).toBe(true);
    expect(input.value).toBe("coke");
    expect(events).toEqual(["input", "change"]);
  });

  it("passes a textVisible assertion when present, fails when absent", async () => {
    mount(`<p>In stock</p>`);
    expect(
      await runReplayStep({
        kind: "assert",
        assertion: { type: "textVisible", text: "In stock" },
      })
    ).toEqual({ ok: true });
    expect(
      (
        await runReplayStep({
          kind: "assert",
          assertion: { type: "textVisible", text: "Sold out" },
        })
      ).ok
    ).toBe(false);
  });

  it("checks inputValue assertions", async () => {
    mount(`<input data-testid="q" value="coke" />`);
    expect(
      (
        await runReplayStep({
          kind: "assert",
          assertion: {
            type: "inputValue",
            target: { testId: "q" },
            equals: "coke",
          },
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await runReplayStep({
          kind: "assert",
          assertion: {
            type: "inputValue",
            target: { testId: "q" },
            equals: "pepsi",
          },
        })
      ).ok
    ).toBe(false);
  });

  it("defers widgetToolCalled to the host", async () => {
    mount(`<div></div>`);
    const result = await runReplayStep({
      kind: "assert",
      assertion: { type: "widgetToolCalled", toolName: "add-to-cart" },
    });
    expect(result).toEqual({ ok: true, deferred: "widgetToolCalled" });
  });
});

describe("RECORDER_SHIM_JS", () => {
  it("is a self-contained IIFE bundling the recorder functions", () => {
    expect(RECORDER_SHIM_JS).toContain("function generateLocator");
    expect(RECORDER_SHIM_JS).toContain("function eventToStep");
    expect(RECORDER_SHIM_JS).toContain("function resolveLocator");
    expect(RECORDER_SHIM_JS).toContain("runReplayStep");
    expect(RECORDER_SHIM_JS).toContain("recorder:replay-step");
    expect(RECORDER_SHIM_JS).toContain("recorderBootstrap()");
    expect(RECORDER_SHIM_JS).toContain(
      "var __name = function(target) { return target; };"
    );
    expect(RECORDER_SHIM_JS.startsWith("(function(){")).toBe(true);
  });

  it("keeps retrying recorder:ready so late arming does not lose attach", () => {
    vi.useFakeTimers();
    const posted: unknown[] = [];
    const postSpy = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((data) => {
        posted.push(data);
      });

    try {
      new Function(RECORDER_SHIM_JS)();
      const readyCount = () =>
        posted.filter(
          (message) =>
            typeof message === "object" &&
            message != null &&
            (message as { type?: string }).type === "recorder:ready"
        ).length;

      expect(readyCount()).toBeGreaterThanOrEqual(1);
      vi.advanceTimersByTime(2500);
      expect(readyCount()).toBeGreaterThan(1);
      vi.advanceTimersByTime(6000);
      expect(readyCount()).toBeGreaterThan(4);
    } finally {
      postSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not depend on the bundler's ambient __name helper", () => {
    const posted: unknown[] = [];
    const postSpy = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((data) => {
        posted.push(data);
      });

    try {
      const runWithoutAmbientBundlerHelpers = new Function(
        "window",
        "document",
        "CSS",
        "var __name; " + RECORDER_SHIM_JS
      );

      expect(() =>
        runWithoutAmbientBundlerHelpers(window, document, CSS)
      ).not.toThrow();
      expect(posted).toContainEqual({ type: "recorder:ready" });
    } finally {
      postSpy.mockRestore();
    }
  });
});
