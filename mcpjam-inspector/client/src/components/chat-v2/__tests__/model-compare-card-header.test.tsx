import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ModelCompareCardHeader,
  type MultiModelCardSummary,
} from "../model-compare-card-header";

const model = {
  id: "anthropic/claude-haiku",
  name: "Claude Haiku 4.5 (Free)",
  provider: "anthropic" as const,
};

const idleSummary: MultiModelCardSummary = {
  modelId: String(model.id),
  durationMs: null,
  tokens: 0,
  toolCount: 0,
  status: "idle",
  hasMessages: false,
};

describe("ModelCompareCardHeader", () => {
  it("renders nothing when comparison chrome is off and trace tabs are hidden", () => {
    const { container } = render(
      <ModelCompareCardHeader
        model={model}
        summary={idleSummary}
        allSummaries={[]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={false}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows trace tabs but not model name or Latency when comparison chrome is off", () => {
    render(
      <ModelCompareCardHeader
        model={model}
        summary={idleSummary}
        allSummaries={[]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={true}
        showComparisonChrome={false}
      />,
    );

    expect(screen.getByTitle("Trace")).toBeInTheDocument();
    expect(screen.queryByText("Latency")).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Haiku/)).not.toBeInTheDocument();
  });

  it("shows comparison chrome when enabled", () => {
    render(
      <ModelCompareCardHeader
        model={model}
        summary={idleSummary}
        allSummaries={[]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
      />,
    );

    expect(screen.getByText(/Claude Haiku/)).toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
  });

  it("uses the sidebar-selected styling for active trace tabs", () => {
    render(
      <ModelCompareCardHeader
        model={model}
        summary={idleSummary}
        allSummaries={[]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={true}
        showComparisonChrome={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass(
      "bg-sidebar-accent",
      "text-sidebar-accent-foreground",
    );
  });

  it("hides status dot and Tools row in compact mode (default)", () => {
    const withTools: MultiModelCardSummary = {
      ...idleSummary,
      toolCount: 3,
      hasMessages: true,
      status: "ready",
    };
    render(
      <ModelCompareCardHeader
        model={model}
        summary={withTools}
        allSummaries={[withTools]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
      />,
    );

    expect(screen.queryByLabelText("Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();
  });

  it("shows status dot and Tools row when compactCompareHeader is false", () => {
    const withTools: MultiModelCardSummary = {
      ...idleSummary,
      toolCount: 2,
      hasMessages: true,
      status: "ready",
      durationMs: 1000,
    };
    render(
      <ModelCompareCardHeader
        model={model}
        summary={withTools}
        allSummaries={[withTools]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
        compactCompareHeader={false}
      />,
    );

    expect(screen.getByLabelText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });
});
