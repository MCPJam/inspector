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

function makeSummary(
  overrides: Partial<MultiModelCardSummary>,
): MultiModelCardSummary {
  return {
    ...idleSummary,
    status: "ready",
    hasMessages: true,
    durationMs: 1000,
    tokens: 100,
    toolCount: 1,
    ...overrides,
  };
}

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
    const withTools = makeSummary({
      toolCount: 2,
    });
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

  it("keeps winner accents neutral while another model is still running", () => {
    const fastest = makeSummary({
      durationMs: 1100,
      tokens: 111,
      toolCount: 1,
    });
    const slower = makeSummary({
      modelId: "openai/gpt-4",
      durationMs: 2200,
      tokens: 222,
      toolCount: 2,
    });
    const running = makeSummary({
      modelId: "google/gemini-2.5-pro",
      status: "running",
      durationMs: null,
      tokens: 0,
      toolCount: 0,
      hasMessages: false,
    });

    render(
      <ModelCompareCardHeader
        model={model}
        summary={fastest}
        allSummaries={[fastest, slower, running]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
        compactCompareHeader={false}
      />,
    );

    expect(screen.getByText("1.1s")).toHaveClass("text-foreground");
    expect(screen.getByText("111")).toHaveClass("text-foreground");
    expect(screen.getByText("1 tool call")).toHaveClass("text-foreground");
  });

  it("excludes errored models from winner selection", () => {
    const winningSuccess = makeSummary({
      durationMs: 1100,
      tokens: 111,
      toolCount: 2,
    });
    const slowerSuccess = makeSummary({
      modelId: "openai/gpt-4",
      durationMs: 2200,
      tokens: 222,
      toolCount: 3,
    });
    const errored = makeSummary({
      modelId: "google/gemini-2.5-pro",
      status: "error",
      durationMs: 900,
      tokens: 90,
      toolCount: 1,
    });

    render(
      <ModelCompareCardHeader
        model={model}
        summary={winningSuccess}
        allSummaries={[winningSuccess, slowerSuccess, errored]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
        compactCompareHeader={false}
      />,
    );

    expect(screen.getByText("1.1s")).toHaveClass("text-emerald-700");
    expect(screen.getByText("111")).toHaveClass("text-emerald-700");
    expect(screen.getByText("2 tool calls")).toHaveClass("text-emerald-700");
  });

  it("keeps winner accents neutral while another model is running even if an errored model is excluded", () => {
    const fastestSuccess = makeSummary({
      durationMs: 1100,
      tokens: 111,
      toolCount: 2,
    });
    const slowerSuccess = makeSummary({
      modelId: "openai/gpt-4",
      durationMs: 2200,
      tokens: 222,
      toolCount: 3,
    });
    const errored = makeSummary({
      modelId: "google/gemini-2.5-pro",
      status: "error",
      durationMs: 900,
      tokens: 90,
      toolCount: 1,
    });
    const running = makeSummary({
      modelId: "xai/grok-4",
      status: "running",
      durationMs: null,
      tokens: 0,
      toolCount: 0,
      hasMessages: false,
    });

    render(
      <ModelCompareCardHeader
        model={model}
        summary={fastestSuccess}
        allSummaries={[fastestSuccess, slowerSuccess, errored, running]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
        compactCompareHeader={false}
      />,
    );

    expect(screen.getByText("1.1s")).toHaveClass("text-foreground");
    expect(screen.getByText("111")).toHaveClass("text-foreground");
    expect(screen.getByText("2 tool calls")).toHaveClass("text-foreground");
  });

  it("restores winner accents once all models are no longer running", () => {
    const fastest = makeSummary({
      durationMs: 1100,
      tokens: 111,
      toolCount: 1,
    });
    const slower = makeSummary({
      modelId: "openai/gpt-4",
      durationMs: 2200,
      tokens: 222,
      toolCount: 2,
    });
    const third = makeSummary({
      modelId: "google/gemini-2.5-pro",
      durationMs: 1500,
      tokens: 150,
      toolCount: 3,
    });

    render(
      <ModelCompareCardHeader
        model={model}
        summary={fastest}
        allSummaries={[fastest, slower, third]}
        mode="chat"
        onModeChange={vi.fn()}
        showTraceTabs={false}
        showComparisonChrome={true}
        compactCompareHeader={false}
      />,
    );

    expect(screen.getByText("1.1s")).toHaveClass("text-emerald-700");
    expect(screen.getByText("111")).toHaveClass("text-emerald-700");
    expect(screen.getByText("1 tool call")).toHaveClass("text-emerald-700");
  });
});
