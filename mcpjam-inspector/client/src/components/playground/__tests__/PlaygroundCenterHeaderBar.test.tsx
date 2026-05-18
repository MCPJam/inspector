import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaygroundCenterHeaderBar } from "@/components/playground/PlaygroundCenterHeaderBar";

vi.mock("@/components/shared/ClientContextHeader", () => ({
  ClientContextHeader: () => <div data-testid="mock-host-header" />,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

describe("PlaygroundCenterHeaderBar", () => {
  const defaultProps = {
    mode: "chat" as const,
    onModeChange: vi.fn(),
    activeProjectId: null,
    protocol: null,
    isMultiModelLayoutMode: false,
  };

  it("stacks host chrome and trace tabs when trace tabs are shown", () => {
    render(
      <PlaygroundCenterHeaderBar {...defaultProps} showTraceTabs />,
    );

    expect(screen.getByTestId("playground-main-header")).toBeInTheDocument();
    expect(screen.getByTestId("mock-host-header")).toBeInTheDocument();
    expect(screen.getByTestId("playground-trace-view-tabs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
  });

  it("shows only host chrome when trace tabs are hidden (e.g. multi-model with messages)", () => {
    render(
      <PlaygroundCenterHeaderBar {...defaultProps} showTraceTabs={false} />,
    );

    expect(screen.getByTestId("mock-host-header")).toBeInTheDocument();
    expect(
      screen.queryByTestId("playground-trace-view-tabs"),
    ).not.toBeInTheDocument();
  });
});
