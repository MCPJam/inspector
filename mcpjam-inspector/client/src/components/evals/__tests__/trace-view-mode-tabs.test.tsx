import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceViewModeTabs } from "../trace-view-mode-tabs";

describe("TraceViewModeTabs", () => {
  it("uses accent active styling for the selected tab (default)", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-accent",
      "text-accent-foreground",
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
      "bg-accent",
      "text-accent-foreground",
    );
  });

  it("leads with Chat in fullWidth order, then Trace then Raw", () => {
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab={false}
        layout="fullWidth"
      />,
    );

    const order = screen
      .getAllByRole("button")
      .map((btn) => btn.textContent?.trim());
    expect(order).toEqual(["Chat", "Trace", "Raw"]);
  });

  it("keeps Chat leading in fullWidth even when the Tool Calls tab is shown", () => {
    // Guards the PUR-14 intent: `chatTab` must sit ahead of the optional
    // `toolsTab`/`browserTab` in the array, not merely appear first because
    // consumers happen to pass showToolsTab={false} today.
    render(
      <TraceViewModeTabs
        mode="chat"
        onModeChange={vi.fn()}
        showToolsTab
        showBrowserTab
        layout="fullWidth"
      />,
    );

    const order = screen
      .getAllByRole("button")
      .map((btn) => btn.textContent?.trim());
    expect(order).toEqual(["Chat", "Tool Calls", "Trace", "Replay", "Raw"]);
  });

  it("hides the Replay tab by default", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
  });

  it("shows the Replay tab when showBrowserTab is set", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
        showBrowserTab
      />,
    );
    expect(
      screen.getByRole("button", { name: "Replay" }),
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

  it("applies active styling to the Replay tab when browserActive is set", () => {
    render(
      <TraceViewModeTabs
        mode="timeline"
        onModeChange={vi.fn()}
        showToolsTab={false}
        showBrowserTab
        browserActive
      />,
    );
    expect(screen.getByRole("button", { name: "Replay" })).toHaveClass(
      "bg-accent",
      "text-accent-foreground",
    );
    // With Replay active, no standard tab is highlighted.
    expect(screen.getByRole("button", { name: "Trace" })).not.toHaveClass(
      "bg-accent",
    );
  });
});
