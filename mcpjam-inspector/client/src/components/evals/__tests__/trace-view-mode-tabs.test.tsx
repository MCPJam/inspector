import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceViewModeTabs } from "../trace-view-mode-tabs";

describe("TraceViewModeTabs", () => {
  it("keeps the default active styling when no variant is requested", () => {
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

  it("can opt into the sidebar active styling when explicitly requested", () => {
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
