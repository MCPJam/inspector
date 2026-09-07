/**
 * The one input allowlist.
 *
 * It exists because three copies of it disagreed, and the way they disagreed
 * was silent: an event the daemon does not recognise comes back 200 having
 * done nothing, and still counts as use — which on a metered box defers the
 * idle sweep for a caller who never touched the browser.
 */
import { describe, expect, it } from "vitest";
import {
  BROWSER_INPUT_BATCH_LIMIT,
  coalesceBrowserPaneInput,
  isBrowserPaneInputEvent,
  parseBrowserPaneInputMessage,
  type BrowserPaneInputEvent,
} from "../browser-pane-input";

describe("input allowlist", () => {
  it("accepts each event the pane can produce", () => {
    const events: BrowserPaneInputEvent[] = [
      { type: "mouse_move", x: 1, y: 2 },
      { type: "mouse_down", x: 1, y: 2, button: "right" },
      { type: "mouse_up", x: 1, y: 2, button: "middle" },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -3 },
      { type: "key_down", key: "Enter" },
      { type: "key_up", key: "Enter" },
      { type: "text", text: "hi" },
    ];
    for (const event of events)
      expect(isBrowserPaneInputEvent(event)).toBe(true);
  });

  it("refuses a shape with the fields its type needs missing", () => {
    expect(isBrowserPaneInputEvent(null)).toBe(false);
    expect(isBrowserPaneInputEvent({ type: "nonsense" })).toBe(false);
    expect(isBrowserPaneInputEvent({ type: "mouse_move" })).toBe(false);
    expect(isBrowserPaneInputEvent({ type: "mouse_move", x: NaN, y: 0 })).toBe(
      false,
    );
    expect(
      isBrowserPaneInputEvent({
        type: "mouse_down",
        x: 0,
        y: 0,
        button: "four",
      }),
    ).toBe(false);
    expect(
      isBrowserPaneInputEvent({ type: "wheel", x: 0, y: 0, deltaX: 1 }),
    ).toBe(false);
    expect(isBrowserPaneInputEvent({ type: "key_down", key: "" })).toBe(false);
  });
});

describe("coalescing", () => {
  it("keeps only the last of a run of moves", () => {
    expect(
      coalesceBrowserPaneInput([
        { type: "mouse_move", x: 1, y: 1 },
        { type: "mouse_move", x: 2, y: 2 },
        { type: "mouse_move", x: 3, y: 3 },
      ]),
    ).toEqual([{ type: "mouse_move", x: 3, y: 3 }]);
  });

  it("sums adjacent wheels rather than dropping distance", () => {
    expect(
      coalesceBrowserPaneInput([
        { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -10 },
        { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -15 },
      ]),
    ).toEqual([{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -25 }]);
  });

  it("never merges a zoom into a scroll, or across a different point", () => {
    const events: BrowserPaneInputEvent[] = [
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -10 },
      { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -10, modifiers: 2 },
      { type: "wheel", x: 9, y: 9, deltaX: 0, deltaY: -10, modifiers: 2 },
    ];
    expect(coalesceBrowserPaneInput(events)).toEqual(events);
  });

  it("keeps a press and its release either side of a collapsed run", () => {
    const events: BrowserPaneInputEvent[] = [
      { type: "mouse_down", x: 1, y: 1, button: "left" },
      { type: "mouse_move", x: 2, y: 2 },
      { type: "mouse_move", x: 3, y: 3 },
      { type: "mouse_up", x: 3, y: 3, button: "left" },
    ];
    expect(coalesceBrowserPaneInput(events)).toEqual([
      events[0],
      { type: "mouse_move", x: 3, y: 3 },
      events[3],
    ]);
  });
});

describe("the wire message", () => {
  it("reads a well-formed batch", () => {
    expect(
      parseBrowserPaneInputMessage({
        seq: 7,
        tabId: "tab-1",
        events: [{ type: "mouse_move", x: 1, y: 2 }],
      }),
    ).toEqual({
      ok: true,
      seq: 7,
      tabId: "tab-1",
      events: [{ type: "mouse_move", x: 1, y: 2 }],
    });
  });

  it("refuses the whole batch when any event is not one", () => {
    // Filtering would deliver a drag missing its release, and the page would
    // sit holding a button down with nothing to say why.
    expect(
      parseBrowserPaneInputMessage({
        seq: 1,
        events: [
          { type: "mouse_down", x: 1, y: 1, button: "left" },
          { type: "?" },
        ],
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
  });

  it("refuses a message with no seq to acknowledge", () => {
    expect(
      parseBrowserPaneInputMessage({
        events: [{ type: "mouse_move", x: 1, y: 1 }],
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
  });

  it("refuses an oversized batch rather than silently dropping its tail", () => {
    // Slicing acknowledged a batch as delivered while discarding the end of
    // it — and a burst that ends with a release then leaves the page holding a
    // button or a key nobody is pressing. Every pane chunks at this same
    // number before it sends, so nothing well-behaved meets this.
    const events = Array.from(
      { length: BROWSER_INPUT_BATCH_LIMIT + 1 },
      (_, i) => ({
        type: "key_down" as const,
        key: String(i),
      }),
    );
    expect(parseBrowserPaneInputMessage({ seq: 1, events })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    // And exactly at the limit is fine.
    const atLimit = events.slice(0, BROWSER_INPUT_BATCH_LIMIT);
    const parsed = parseBrowserPaneInputMessage({ seq: 1, events: atLimit });
    expect(parsed.ok && parsed.events).toHaveLength(BROWSER_INPUT_BATCH_LIMIT);
  });

  it("refuses an optional field of the wrong shape", () => {
    // Accepted, a `modifiers: "ctrl"` reached CDP as a string where a bitmask
    // belongs: the dispatch failed there, on a batch already acknowledged as
    // delivered, and nothing anywhere said so.
    for (const bad of [
      { type: "mouse_move", x: 1, y: 1, modifiers: "ctrl" },
      { type: "mouse_move", x: 1, y: 1, modifiers: Number.NaN },
      { type: "mouse_down", x: 1, y: 1, button: "left", clickCount: "2" },
      { type: "key_down", key: "a", code: 65 },
    ]) {
      expect(isBrowserPaneInputEvent(bad)).toBe(false);
    }
    // And the same events with the right shapes still pass.
    expect(
      isBrowserPaneInputEvent({ type: "mouse_move", x: 1, y: 1, modifiers: 2 }),
    ).toBe(true);
    expect(
      isBrowserPaneInputEvent({ type: "key_down", key: "a", code: "KeyA" }),
    ).toBe(true);
  });
});

describe("fields CDP declares as integers", () => {
  it("refuses a fractional modifier bitmask", () => {
    // 1.5 is not a weaker Ctrl. It is a value with no meaning, and it failed
    // one hop past the acknowledgement — in CDP, on a batch this relay had
    // already told the pane was delivered.
    expect(
      isBrowserPaneInputEvent({ type: "mouse_move", x: 1, y: 1, modifiers: 1.5 }),
    ).toBe(false);
    expect(
      isBrowserPaneInputEvent({ type: "mouse_move", x: 1, y: 1, modifiers: 2 }),
    ).toBe(true);
  });

  it("refuses a fractional click count", () => {
    const event = {
      type: "mouse_down",
      x: 1,
      y: 1,
      button: "left",
      clickCount: 2.5,
    };
    expect(isBrowserPaneInputEvent(event)).toBe(false);
    expect(isBrowserPaneInputEvent({ ...event, clickCount: 2 })).toBe(true);
  });

  it("still takes a fractional wheel delta, which is a real distance", () => {
    expect(
      isBrowserPaneInputEvent({
        type: "wheel",
        x: 1,
        y: 1,
        deltaX: 0,
        deltaY: -0.5,
      }),
    ).toBe(true);
  });
});
