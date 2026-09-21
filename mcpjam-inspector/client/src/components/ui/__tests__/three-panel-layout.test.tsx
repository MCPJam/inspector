import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { ThreePanelLayout } from "../three-panel-layout";

vi.mock("@/components/logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view">Logger</div>,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

describe("ThreePanelLayout", () => {
  it("mounts LoggerView when no custom right rail is passed", () => {
    render(
      <ThreePanelLayout
        id="tools"
        sidebar={<div>sidebar</div>}
        content={<div>content</div>}
        sidebarVisible
        onSidebarVisibilityChange={() => {}}
        serverName="demo"
      />,
    );
    expect(screen.getByTestId("logger-view")).toBeInTheDocument();
  });

  it("renders a custom right rail and does not mount LoggerView", () => {
    render(
      <ThreePanelLayout
        id="webmcp"
        sidebar={<div>sidebar</div>}
        content={<div>content</div>}
        sidebarVisible
        onSidebarVisibilityChange={() => {}}
        right={<div>activity logs</div>}
        rightVisible
        onRightVisibilityChange={() => {}}
      />,
    );
    expect(screen.getByText("activity logs")).toBeInTheDocument();
    expect(screen.queryByTestId("logger-view")).toBeNull();
  });
});
