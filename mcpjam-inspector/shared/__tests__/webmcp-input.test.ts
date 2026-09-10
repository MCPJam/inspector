import { describe, expect, it } from "vitest";
import {
  fromBrowserPaneInput,
  toBrowserPaneInput,
  webMcpSocketInputSchema,
} from "../webmcp-input";
import { coalesceBrowserPaneInput } from "../browser-pane-input";
import type { WebMcpInputEvent } from "../webmcp-inspector-protocol";

const wheel = {
  kind: "wheel" as const,
  x: 20,
  y: 30,
  deltaX: 0,
  deltaY: 10,
  modifiers: { alt: false, ctrl: true, meta: false, shift: false },
};
describe("WebMCP socket input boundary", () => {
  it("preserves input semantics through the shared relay vocabulary", () => {
    const events: WebMcpInputEvent[] = [
      wheel,
      { kind: "key_down", key: "Shift", modifiers: wheel.modifiers },
      {
        kind: "mouse_down",
        x: 1,
        y: 2,
        button: "left",
        clickCount: 2,
        modifiers: wheel.modifiers,
      },
      { kind: "text", text: "日本語" },
    ];
    expect(events.map(toBrowserPaneInput).map(fromBrowserPaneInput)).toEqual(
      events,
    );
  });
  it("sums compatible wheels but preserves reversal, modifiers, and release order", () => {
    const events: WebMcpInputEvent[] = [
      wheel,
      wheel,
      { ...wheel, deltaY: -10 },
      { ...wheel, modifiers: { ctrl: false } },
      { kind: "mouse_move", x: 1, y: 1, modifiers: { shift: true } },
      { kind: "mouse_move", x: 2, y: 2, modifiers: { shift: false } },
      { kind: "mouse_up", x: 2, y: 2, button: "left" },
    ];
    const output = coalesceBrowserPaneInput(
      events.map(toBrowserPaneInput),
      true,
    );
    expect(output).toHaveLength(6);
    expect(output[0]).toMatchObject({ type: "wheel", deltaY: 20 });
    expect(output[1]).toMatchObject({ type: "wheel", deltaY: -10 });
    expect(output.at(-1)).toMatchObject({ type: "mouse_up" });
  });
  it.each([
    [],
    Array(65).fill(wheel),
    [{ ...wheel, x: -1 }],
    [{ ...wheel, deltaY: Infinity }],
    [{ kind: "text", text: "a".repeat(4097) }],
  ])("refuses invalid batches", (events) => {
    expect(
      webMcpSocketInputSchema.safeParse({ type: "input", seq: 1, events })
        .success,
    ).toBe(false);
  });
});
