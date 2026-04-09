import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceViewModeTabs } from "../trace-view-mode-tabs";

describe("TraceViewModeTabs", () => {
  it("keeps the existing default active styling", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-primary/10",
      "text-foreground",
    );
  });

  it("can use the sidebar active styling for chat surfaces", () => {
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
