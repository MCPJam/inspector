import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { JsonTreeView } from "../json-tree-view";

describe("JsonTreeView", () => {
  it("renders a collapsed deeply nested node without serializing its subtree (INSPECTOR-CLIENT-232)", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < 50_000; i++) {
      const next: Record<string, unknown> = {};
      cursor.a = next;
      cursor = next;
    }

    // A collapsed node still renders a copy button for its subtree. Serializing
    // that subtree eagerly at render throws RangeError: Maximum call stack size
    // exceeded on this value, so the button's value must stay a thunk.
    expect(() =>
      render(<JsonTreeView value={root} collapsedPaths={new Set(["root"])} />),
    ).not.toThrow();
  });
});
