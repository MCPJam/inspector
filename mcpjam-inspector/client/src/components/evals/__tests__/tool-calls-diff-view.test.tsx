import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ToolCallsDiffView } from "../tool-calls-diff-view";

describe("ToolCallsDiffView", () => {
  it("renders a clean pass banner when everything matches", () => {
    render(
      <ToolCallsDiffView
        expected={[{ toolName: "search-products", arguments: { query: "redbull" } }]}
        actual={[{ toolName: "search-products", arguments: { query: "redbull" } }]}
      />,
    );
    expect(
      screen.getByText("All 1 expected tool call matched."),
    ).toBeInTheDocument();
    // Match rows lead with the quiet "match" verdict.
    expect(screen.getByText("match")).toBeInTheDocument();
  });

  it("flags an unexpected extra call with an inline arg preview", () => {
    // The "Show me a redbull" case: two matches + one unexpected add-to-cart.
    render(
      <ToolCallsDiffView
        expected={[
          { toolName: "search-products", arguments: { query: "redbull" } },
          { toolName: "view-cart", arguments: {} },
        ]}
        actual={[
          { toolName: "search-products", arguments: { query: "redbull" } },
          { toolName: "view-cart", arguments: {} },
          { toolName: "add-to-cart", arguments: { id: "redbull" } },
        ]}
      />,
    );

    expect(screen.getByText("1 difference")).toBeInTheDocument();
    expect(screen.getByText(/2 expected, 3 actual/)).toBeInTheDocument();
    expect(screen.getByText("unexpected")).toBeInTheDocument();
    // The extra call's args are previewed inline without expanding.
    expect(screen.getByText(/id: "redbull"/)).toBeInTheDocument();
  });

  it("shows a per-key old → new diff for an argument mismatch", () => {
    render(
      <ToolCallsDiffView
        expected={[{ toolName: "search-products", arguments: { query: "redbull" } }]}
        actual={[{ toolName: "search-products", arguments: { query: "monster" } }]}
      />,
    );
    expect(screen.getByText("arg diff")).toBeInTheDocument();
    // Auto-expanded: both old and new values are visible.
    expect(screen.getByText('"redbull"')).toBeInTheDocument();
    expect(screen.getByText('"monster"')).toBeInTheDocument();
  });

  it("marks an expected-but-missing call", () => {
    render(
      <ToolCallsDiffView
        expected={[{ toolName: "view-cart", arguments: {} }]}
        actual={[]}
      />,
    );
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("expands a one-sided extra row to its arguments on click", () => {
    render(
      <ToolCallsDiffView
        expected={[]}
        actual={[{ toolName: "add-to-cart", arguments: { id: "redbull" } }]}
      />,
    );
    const row = screen.getByText("add-to-cart").closest("div")!;
    fireEvent.click(within(row).getByRole("button"));
    expect(screen.getByText("Called, not expected")).toBeInTheDocument();
  });
});
