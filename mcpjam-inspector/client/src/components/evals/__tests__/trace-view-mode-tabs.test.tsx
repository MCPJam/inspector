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

  it("matches the same active styling in fullWidth layout", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
        layout="fullWidth"
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-sidebar-accent",
      "text-sidebar-accent-foreground",
    );
  });

  it("hides the App tab by default", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
  });

  it("shows the App tab when showBrowserTab is set", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
        showBrowserTab
      />,
    );
    expect(
      screen.getByRole("button", { name: "App" }),
    ).toBeInTheDocument();
  });

  it("uses segment styling when appearance is segment", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
        appearance="segment"
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-background",
      "ring-inset",
    );
  });

  it("applies active styling to the App tab when browserActive is set", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
        showBrowserTab
        browserActive
      />,
    );
    expect(screen.getByRole("button", { name: "App" })).toHaveClass(
      "bg-sidebar-accent",
      "text-sidebar-accent-foreground",
    );
    // With App active, no standard tab is highlighted.
    expect(screen.getByRole("button", { name: "Trace" })).not.toHaveClass(
      "bg-sidebar-accent",
    );
  });
});
