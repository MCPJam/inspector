/**
 * What a session transcript actually draws for a tool payload.
 *
 * The ask was to REUSE the Playground's viewer rather than approximate it, so
 * these assert the behaviour that viewer has and the package's `<pre>` never
 * did: collapsible nodes, a depth the tree stops at, and a per-node copy
 * control. A test that only checked the seam was passed would pass against a
 * renderer that drew another plain block.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { renderSessionJson } from "../session-json-view";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

const PAYLOAD = {
  city: "san francisco",
  structuredContent: {
    temperatureC: 5,
    conditions: "rainy",
    nested: { deep: { deeper: "value" } },
  },
};

function renderPayload(value: unknown = PAYLOAD) {
  return render(<>{renderSessionJson(value, JSON.stringify(value, null, 2))}</>);
}

describe("renderSessionJson", () => {
  it("renders an interactive tree, not a preformatted dump", () => {
    const { container } = renderPayload();

    // The package's own JSON block, which this replaces.
    expect(container.querySelector(".mcpjam-chat-json")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    // Collapse toggles — the thing a `<pre>` cannot offer.
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("opens two levels and leaves the rest collapsed", () => {
    // Same `defaultExpandDepth` the Playground passes. It is also what keeps
    // this readable inside a transcript: the top level and its children open,
    // and anything deeper arrives collapsed for the reader to open if they
    // care.
    const { container } = renderPayload();
    const text = container.textContent ?? "";

    expect(text).toContain("city");
    expect(text).toContain("structuredContent");
    // Depth 2 — present as a key.
    expect(text).toContain("nested");
    // Depth 4 — behind a collapsed node, so its value is not in the output.
    expect(text).not.toContain("deeper");
  });

  it("expands a collapsed node when it is clicked", () => {
    const { container } = renderPayload();
    expect(container.textContent).not.toContain("deeper");

    // The toggle is a SIBLING of the key label, not a wrapper around it, so
    // it is found through the row rather than by its own text.
    const row = Array.from(container.querySelectorAll("div")).find(
      (node) =>
        (node.textContent ?? "").includes("nested") &&
        node.querySelector('.json-collapse-toggle[data-state="closed"]') !==
          null,
    );
    expect(row).toBeDefined();
    fireEvent.click(
      row!.querySelector('.json-collapse-toggle[data-state="closed"]')!,
    );

    // Two more levels of it are now reachable.
    expect(container.textContent).toContain("deep");
  });

  it("renders a primitive payload without throwing", () => {
    // A tool that returns a bare string or number still reaches this. The tree
    // has to be total over what `renderJson` can be handed, not just objects.
    expect(() => renderPayload("just a string")).not.toThrow();
    expect(screen.getByText(/just a string/)).toBeInTheDocument();
  });
});
