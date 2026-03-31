import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(value)}</div>
  ),
}));

describe("TraceTimeline detail pane", () => {
  it("shows tool input from transcript when span has toolName but no toolCallId", () => {
    const spans: EvalTraceSpan[] = [
      {
        id: "step-root",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 500,
        stepIndex: 0,
      },
      {
        id: "tool-a",
        parentId: "step-root",
        name: "read_me",
        category: "tool",
        startMs: 100,
        endMs: 220,
        stepIndex: 0,
        toolName: "read_me",
      },
    ];

    const transcriptMessages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-99",
            toolName: "read_me",
            input: { path: "README.md" },
          },
        ],
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    const toolRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes("read_me"));
    expect(toolRow).toBeTruthy();
    fireEvent.click(within(toolRow!).getByTestId("trace-row-label-button"));

    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByTestId("json-editor").textContent).toContain(
      "README.md",
    );
  });

  it("hides step rows from the waterfall (only LLM/tool/error spans are shown)", () => {
    const spans = [
      {
        id: "p0-step0",
        name: "Step 1",
        category: "step" as const,
        startMs: 0,
        endMs: 120,
        promptIndex: 0,
        stepIndex: 0,
        messageStartIndex: 1,
        messageEndIndex: 3,
      },
    ];
    const transcriptMessages = [
      { role: "user", content: "Need docs" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-docs",
            toolName: "read_docs",
            input: { topic: "telemetry" },
          },
        ],
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    // Step rows are no longer rendered — only the prompt row should exist
    const allRows = screen.getAllByTestId("trace-row");
    const stepRow = allRows.find((el) => el.textContent?.includes("Step 1"));
    expect(stepRow).toBeUndefined();
  });

  it("marks tool spans as failed from transcript when persisted status is ok", async () => {
    const user = userEvent.setup();
    const spans: EvalTraceSpan[] = [
      {
        id: "step-root",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 500,
        stepIndex: 0,
      },
      {
        id: "tool-create-view",
        parentId: "step-root",
        name: "create_view",
        category: "tool",
        status: "ok",
        startMs: 100,
        endMs: 300,
        stepIndex: 0,
        toolCallId: "call-cv",
        toolName: "create_view",
      },
    ];

    const transcriptMessages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-cv",
            toolName: "create_view",
            input: { elements: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-cv",
            toolName: "create_view",
            result: {
              isError: true,
              content: [{ type: "text", text: "Invalid JSON in elements" }],
            },
          },
        ],
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    const toolRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes("create_view"));
    expect(toolRow).toBeTruthy();
    fireEvent.click(
      within(toolRow!).getByRole("button", { name: /Tool · create_view/i }),
    );

    const errorBar = screen.getByTestId("trace-row-bar-error");
    expect(errorBar.className).toContain("bg-primary");

    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByLabelText("Error")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Filter timeline rows/ }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Error" }),
    );
    expect(
      screen
        .getAllByTestId("trace-row")
        .some((el) => el.textContent?.includes("create_view")),
    ).toBe(true);
  });

  it("Reset on embedded toolbar restores filter to All", async () => {
    const user = userEvent.setup();
    const spans: EvalTraceSpan[] = [
      {
        id: "a",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 50,
      },
      {
        id: "b",
        parentId: "a",
        name: "t",
        category: "tool",
        startMs: 10,
        endMs: 20,
        toolName: "t",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[{ role: "user", content: "hi" }]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Filter timeline rows/ }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Tool" }),
    );
    expect(
      screen.getByRole("button", { name: /Filter timeline rows: Tool/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset trace view" }));
    expect(
      screen.getByRole("button", { name: /Filter timeline rows: All/ }),
    ).toBeInTheDocument();
  });

  it("renders stacked input and output on span selection", async () => {
    const user = userEvent.setup();
    const spans: EvalTraceSpan[] = [
      {
        id: "tool-a",
        name: "read_me",
        category: "tool",
        startMs: 0,
        endMs: 20,
        toolName: "read_me",
      },
    ];
    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: "read_me",
                input: { x: 1 },
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Tool · read_me/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(pane).getByText("Input")).toBeInTheDocument();
    expect(within(pane).getByText("Output")).toBeInTheDocument();
  });

  it("labels generic LLM spans as LLM · short model (not Model response)", () => {
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-a",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 500,
        promptIndex: 0,
        modelId: "openai/gpt-5.4-nano",
        stepIndex: 0,
        totalTokens: 100,
      },
      {
        id: "llm-b",
        name: "openai/gpt-5.4-nano · response",
        category: "llm",
        startMs: 600,
        endMs: 1200,
        promptIndex: 0,
        modelId: "openai/gpt-5.4-nano",
        stepIndex: 1,
        totalTokens: 200,
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[{ role: "user", content: "hi" }]}
      />,
    );

    const rows = screen.getAllByTestId("trace-row");
    const llmRows = rows.filter((el) =>
      el.textContent?.includes("LLM call"),
    );
    expect(llmRows.length).toBeGreaterThanOrEqual(2);
  });

  it("shows user message as prompt row label with stats subtitle", () => {
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-1",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 400,
        promptIndex: 0,
        modelId: "anthropic/claude-3-haiku",
        totalTokens: 50,
      },
      {
        id: "tool-1",
        name: "grep",
        category: "tool",
        startMs: 400,
        endMs: 800,
        promptIndex: 0,
        toolName: "grep",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[{ role: "user", content: "find it" }]}
      />,
    );

    // User message should be promoted to the primary label
    const promptRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes('User: "find it"'));
    expect(promptRow).toBeTruthy();
    // Stats subtitle should include prompt number and counts
    expect(promptRow!.textContent).toMatch(/Prompt 1/);
    expect(promptRow!.textContent).toMatch(/1 LLM/);
    expect(promptRow!.textContent).toMatch(/1 tool/);
  });
});
