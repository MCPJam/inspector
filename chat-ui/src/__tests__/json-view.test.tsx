import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import {
  HIGHLIGHT_CHAR_LIMIT,
  JsonView,
  renderJsonText,
} from "../parts/json-view";

const pre = (container: HTMLElement) =>
  container.querySelector(".mcpjam-chat-json") as HTMLElement;

/**
 * BB-239: the Playground syntax-highlighted a tool payload and Sessions
 * rendered the same bytes as a monochrome `<pre>`. Both now colour from
 * `internal/json-tokens`.
 *
 * Losslessness is the property under test throughout. It is structural — the
 * render loop emits every character the tokenizer did not claim — so these
 * check it on BOTH paths, coloured and plain, rather than trusting the gate to
 * protect it. The coloured path's gap emission is pinned by the indentation
 * and escapes in "shows exactly the text it was given"; delete either gap
 * branch in `JsonView` and that case fails.
 */
describe("JsonView", () => {
  it("colours keys, strings, numbers, booleans and null", () => {
    const value = { name: "mcpjam", count: 3, ok: true, off: false, x: null };
    const { container } = render(<JsonView value={value} />);

    expect(container.querySelector(".json-key")).not.toBeNull();
    expect(container.querySelector(".json-string")).not.toBeNull();
    expect(container.querySelector(".json-number")).not.toBeNull();
    expect(container.querySelector(".json-boolean")).not.toBeNull();
    expect(container.querySelector(".json-boolean-false")).not.toBeNull();
    expect(container.querySelector(".json-null")).not.toBeNull();
  });

  it("shows exactly the text it was given, indentation included", () => {
    const value = { a: { b: [1, 2] }, c: "two words", "d\\e": "é😀́" };
    const text = renderJsonText(value);
    const { container } = render(<JsonView value={value} />);
    // Not `toContain`: the block must equal the string it was given.
    expect(pre(container).textContent).toBe(text);
  });

  it("is lossless for a realistic malformed payload", () => {
    // A tool result with JS-isms in it. Passes the opener check, fails the
    // parse, so it takes the PLAIN path — and the tokens it would have lost
    // there (`NaN`, `undefined`, `0x1F`) must still be on screen.
    const text = '{"a": NaN, "b": undefined, "c": 0x1F}';
    const { container } = render(<JsonView value={text} />);
    expect(pre(container).textContent).toBe(text);
    expect(pre(container).querySelector("span")).toBeNull();
  });

  it("leaves structural-looking text that is not JSON uncoloured", () => {
    // The near-miss: opens with `{`, so an opener-only gate would colour its
    // braces. `querySelector("span")` is the assertion that fails if the gate
    // is removed — the text itself is lossless either way.
    const text = "{connection failed}";
    const { container } = render(<JsonView value={text} />);
    expect(pre(container).textContent).toBe(text);
    expect(pre(container).querySelector("span")).toBeNull();
  });

  it("leaves a prose payload uncoloured", () => {
    const prose = "Error: connection refused (attempt 2 of 3)";
    const { container } = render(<JsonView value={prose} />);
    expect(pre(container).textContent).toBe(prose);
    expect(pre(container).querySelector("span")).toBeNull();
  });

  it("renders a payload one character over the cap complete but uncoloured", () => {
    // The path a multi-megabyte tool result takes. Colour is the thing that is
    // allowed to go; the payload is not. Sized so the serialised text is
    // exactly one character over, which is the boundary worth pinning.
    const envelope = JSON.stringify({ a: "" }).length;
    const padding = "x".repeat(HIGHLIGHT_CHAR_LIMIT + 1 - envelope);
    const text = JSON.stringify({ a: padding });
    expect(text.length).toBe(HIGHLIGHT_CHAR_LIMIT + 1);

    const { container } = render(<JsonView value={text} />);
    expect(pre(container).textContent).toBe(text);
    expect(pre(container).querySelector("span")).toBeNull();
  });

  it("renders a circular payload instead of collapsing it", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const { container } = render(<JsonView value={cyclic} />);
    expect(pre(container).textContent).toContain("[Circular]");
    expect(pre(container).textContent).not.toContain("[object Object]");
  });
});
