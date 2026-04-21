import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceViewModeTabs } from "../trace-view-mode-tabs";

describe("TraceViewModeTabs", () => {
  it("uses sidebar-accent active styling for the selected tab (default)", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-sidebar-accent",
      "text-sidebar-accent-foreground",
    );
  });

  it("matches the same active styling when activeVariant is sidebar", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
        activeVariant="sidebar"
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-sidebar-accent",
      "text-sidebar-accent-foreground",
    );
  });
});
