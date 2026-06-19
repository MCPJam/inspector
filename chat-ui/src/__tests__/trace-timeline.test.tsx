import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { TraceTimeline } from "../internal/trace-timeline/trace-timeline";
import type { TraceSpan } from "../internal/trace-timeline/eval-trace";

const spans: TraceSpan[] = [
  {
    id: "p0-llm",
    name: "Agent",
    category: "llm",
    startMs: 0,
    endMs: 2420,
    promptIndex: 0,
    stepIndex: 0,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  },
  {
    id: "p0-tool",
    name: "read_me",
    category: "tool",
    startMs: 2420,
    endMs: 2516,
    promptIndex: 0,
    toolCallId: "tc1",
    toolName: "read_me",
  },
];

describe("TraceTimeline (recorded waterfall)", () => {
  it("renders waterfall rows with per-span latency for recorded spans", () => {
    const { getAllByTestId, getByText, container } = render(
      <TraceTimeline recordedSpans={spans} />,
    );

    // Self-applies the `.mcpjam-chat-ui` scope root (tokens + waterfall classes
    // live under it), so the timeline styles without a consumer wrapper.
    expect(container.querySelector(".mcpjam-chat-ui")).not.toBeNull();

    // A prompt group row + the two span rows should all render.
    expect(getAllByTestId("trace-row").length).toBeGreaterThanOrEqual(2);

    // Tool span surfaces its name and its 96ms latency.
    getByText("Tool · read_me");
    getByText("96ms");
    // LLM span latency (2420ms -> "2.42s").
    getByText("2.42s");
  });

  it("renders the empty state when there are no recorded spans", () => {
    const { getByText } = render(<TraceTimeline recordedSpans={[]} />);
    getByText(/No timing data recorded/i);
  });

  it("shows harness metadata (provider/finish) in the detail pane for llm spans", () => {
    const llmSpans: TraceSpan[] = [
      {
        id: "p0-llm",
        name: "Agent",
        category: "llm",
        startMs: 0,
        endMs: 2420,
        promptIndex: 0,
        stepIndex: 0,
        outputTokens: 50,
        finishReason: "length",
        provider: "anthropic",
      },
    ];
    const { getAllByTestId, getByTestId } = render(
      <TraceTimeline recordedSpans={llmSpans} />,
    );
    const labelButtons = getAllByTestId("trace-row-label-button");
    fireEvent.click(labelButtons[labelButtons.length - 1]);
    const meta = getByTestId("trace-span-metadata");
    expect(meta.textContent).toContain("anthropic");
    expect(meta.textContent).toContain("length");
  });

  it("shows the JSON-RPC error code on a failed tool span", () => {
    const spans: TraceSpan[] = [
      {
        id: "p0-tool",
        name: "create_view",
        category: "tool",
        startMs: 0,
        endMs: 96,
        promptIndex: 0,
        status: "error",
        toolCallId: "tc1",
        toolName: "create_view",
        mcpErrorCode: -32602,
      },
    ];
    const { getAllByTestId, getByTestId } = render(
      <TraceTimeline recordedSpans={spans} />,
    );
    const labelButtons = getAllByTestId("trace-row-label-button");
    fireEvent.click(labelButtons[labelButtons.length - 1]);
    const codeEl = getByTestId("trace-mcp-error-code");
    expect(codeEl.textContent).toContain("-32602");
    expect(codeEl.textContent).toContain("Invalid params");
  });
});
