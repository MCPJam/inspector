import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { JsonView, renderJsonText } from "../parts/json-view";

/**
 * BB-239: the Playground syntax-highlighted a tool payload and Sessions
 * rendered the same bytes as a monochrome `<pre>`. Both now colour from
 * `internal/json-tokens`, so these assert the token spans exist AND that the
 * text is unchanged — a highlighter that drops characters would be a worse
 * regression than no colour at all.
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
    const value = { a: { b: [1, 2] }, c: "two words" };
    const text = renderJsonText(value);
    const { container } = render(<JsonView value={value} />);
    const pre = container.querySelector(".mcpjam-chat-json") as HTMLElement;
    // Not `toContain`: the whole point is that highlighting is lossless, so
    // the block must equal the string `FoldedBlock` measured.
    expect(pre.textContent).toBe(text);
  });

  it("leaves a non-JSON string payload alone rather than feeding it to the tokenizer", () => {
    // The tokenizer skips characters it does not recognise, so prose run
    // through it would render as a handful of surviving fragments. A payload
    // that does not open with `{` or `[` must stay plain text.
    const prose = "Error: connection refused (attempt 2 of 3)";
    const { container } = render(<JsonView value={prose} />);
    const pre = container.querySelector(".mcpjam-chat-json") as HTMLElement;
    expect(pre.textContent).toBe(prose);
    expect(pre.querySelector(".json-key")).toBeNull();
  });

  it("renders a circular payload instead of collapsing it", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const { container } = render(<JsonView value={cyclic} />);
    const pre = container.querySelector(".mcpjam-chat-json") as HTMLElement;
    expect(pre.textContent).toContain("[Circular]");
    expect(pre.textContent).not.toContain("[object Object]");
  });

  it("prefers the caller's pre-rendered text over re-serialising the value", () => {
    const { container } = render(
      <JsonView value={{ a: 1 }} text={'{ "measured": true }'} />
    );
    const pre = container.querySelector(".mcpjam-chat-json") as HTMLElement;
    expect(pre.textContent).toBe('{ "measured": true }');
  });
});
