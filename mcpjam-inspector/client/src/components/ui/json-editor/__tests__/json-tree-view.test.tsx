import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { JsonTreeView } from "../json-tree-view";
import { copyToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

function deeplyNested(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < levels; i++) {
    const next: Record<string, unknown> = {};
    cursor.a = next;
    cursor = next;
  }
  return root;
}

// Copy buttons carry no accessible name; the collapse toggles are the only
// other buttons in the tree.
function copyButtons(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "button:not(.json-collapse-toggle)",
    ),
  );
}

describe("JsonTreeView", () => {
  beforeEach(() => {
    vi.mocked(copyToClipboard).mockClear();
  });

  it("honors defaultExpandDepth on the first paint (INSPECTOR-CLIENT-232)", () => {
    const { container } = render(
      <JsonTreeView value={deeplyNested(50_000)} defaultExpandDepth={2} />,
    );

    // Root, its child, and the collapsed boundary node — nothing below. Seeding
    // the collapse state in a post-render effect instead paints all 50k levels
    // once before collapsing them, which exhausts the renderer's heap.
    expect(container.querySelectorAll(".json-collapse-toggle")).toHaveLength(3);
  });

  it("renders a collapsed deeply nested node without serializing its subtree (INSPECTOR-CLIENT-232)", () => {
    const root = deeplyNested(50_000);

    // A collapsed node still renders a copy button for its subtree. Serializing
    // that subtree eagerly at render throws RangeError: Maximum call stack size
    // exceeded on this value, so the button's value must stay a thunk.
    expect(() =>
      render(<JsonTreeView value={root} collapsedPaths={new Set(["root"])} />),
    ).not.toThrow();
  });

  it("serializes the subtree when the copy button is actually clicked", async () => {
    const onCopy = vi.fn();
    const value = { a: 1, b: { c: 2 } };
    const { container } = render(
      <JsonTreeView value={value} onCopy={onCopy} />,
    );

    // Deferring serialization must not lose it: the first copy button is the
    // root object's, and it still yields the whole subtree.
    fireEvent.click(copyButtons(container)[0]);

    const expected = JSON.stringify(value, null, 2);
    expect(copyToClipboard).toHaveBeenCalledWith(expected);
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith(expected));
  });

  it("skips the copy when the subtree cannot be serialized", () => {
    const onCopy = vi.fn();
    // JSON.stringify throws on a BigInt.
    const { container } = render(
      <JsonTreeView value={{ n: 1n }} onCopy={onCopy} />,
    );

    expect(() => fireEvent.click(copyButtons(container)[0])).not.toThrow();
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("copies literal text for null and empty containers", () => {
    const { container } = render(
      <JsonTreeView value={{ a: null, b: {}, c: [] }} />,
    );

    copyButtons(container).forEach((button) => fireEvent.click(button));

    const copied = vi.mocked(copyToClipboard).mock.calls.map(([arg]) => arg);
    expect(copied).toContain("null");
    expect(copied).toContain("{}");
    expect(copied).toContain("[]");
    // Never hands the clipboard a non-string.
    expect(copied.every((arg) => typeof arg === "string")).toBe(true);
  });
});
