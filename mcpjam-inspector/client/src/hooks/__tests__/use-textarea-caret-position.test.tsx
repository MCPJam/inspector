import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { useTextareaCaretPosition } from "../use-textarea-caret-position";

function renderWithValue(value: string, caretIndex = value.length) {
  const textarea = document.createElement("textarea");
  const container = document.createElement("div");
  document.body.append(textarea, container);

  const textareaRef = createRef<HTMLTextAreaElement>();
  const containerRef = createRef<HTMLDivElement>();
  // renderHook can't attach refs to detached nodes, so assign them directly.
  Object.assign(textareaRef, { current: textarea });
  Object.assign(containerRef, { current: container });

  const view = renderHook(() =>
    useTextareaCaretPosition(textareaRef, containerRef, value, caretIndex),
  );

  // The mirror is the last child the hook appended to <body>.
  const mirror = document.body.lastElementChild as HTMLDivElement;
  return { view, mirror };
}

describe("useTextareaCaretPosition", () => {
  it("renders composer text as text, not markup", () => {
    const payload = `<img src=x onerror="globalThis.__pwned = true">`;
    const { mirror } = renderWithValue(payload);

    expect(document.querySelector("img")).toBeNull();
    expect(mirror.querySelector("img")).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    // The payload is still measured, just as inert text.
    expect(mirror.textContent).toContain(payload);
  });

  it("keeps the caret marker measurable between the two halves", () => {
    const { mirror } = renderWithValue("hello world", 5);

    const marker = mirror.querySelector("span");
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe("|");
    expect(mirror.textContent).toBe("hello| world");
  });

  it("does not let a payload forge the caret marker", () => {
    const { mirror } = renderWithValue(`<span id="caret-marker">X</span>`, 0);

    // One real marker, created by the hook — the text never became an element.
    expect(mirror.querySelectorAll("span")).toHaveLength(1);
    expect(mirror.querySelector("span")?.textContent).toBe("|");
  });
});
