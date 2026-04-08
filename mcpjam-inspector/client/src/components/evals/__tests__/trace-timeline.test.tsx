import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { selectAxisTickPercents, TraceTimeline } from "../trace-timeline";

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

describe("selectAxisTickPercents", () => {
  it("uses only endpoints when unmeasured, zero, or very narrow", () => {
    expect(selectAxisTickPercents(-1)).toEqual([0, 100]);
    expect(selectAxisTickPercents(0)).toEqual([0, 100]);
    expect(selectAxisTickPercents(60)).toEqual([0, 100]);
  });

  it("adds a middle tick when there is moderate width", () => {
    expect(selectAxisTickPercents(180)).toEqual([0, 50, 100]);
  });

  it("omits the center tick but keeps quartiles when between moderate and full", () => {
    expect(selectAxisTickPercents(220)).toEqual([0, 25, 75, 100]);
  });

  it("shows all default ticks when the axis is wide enough", () => {
    expect(selectAxisTickPercents(300)).toEqual([0, 25, 50, 75, 100]);
  });
});

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
    expect(
      within(toolRow!).getByTestId("trace-row-label-button"),
    ).not.toHaveTextContent(/120ms/);
    expect(
      screen
        .getAllByTestId("trace-row-duration-hit")
        .some((el) => el.textContent?.includes("120ms")),
    ).toBe(true);
    expect(toolRow!.textContent).not.toContain("README.md");
    fireEvent.click(within(toolRow!).getByTestId("trace-row-label-button"));

    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByTestId("json-editor").textContent).toContain(
      "README.md",
    );
    expect(
      within(pane).queryByRole("button", { name: "JSON" }),
    ).not.toBeInTheDocument();
    expect(
      within(pane).queryByRole("button", { name: "Plain" }),
    ).not.toBeInTheDocument();
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
    expect(errorBar.className).toContain("trace-waterfall-bar-error");

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

  it("does not render a reset button in the embedded toolbar", async () => {
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

    expect(
      screen.queryByRole("button", { name: "Reset trace view" }),
    ).not.toBeInTheDocument();
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

  it("selects a row from the trailing duration cell", async () => {
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

    const toolRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes("read_me"));
    expect(toolRow).toBeTruthy();
    await user.click(within(toolRow!).getByTestId("trace-row-duration-hit"));
    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByText("Tool · read_me")).toBeInTheDocument();
  });

  it("labels generic LLM spans as Agent and keeps tokens out of the inline row text", () => {
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
    const llmRows = rows.filter((el) => el.textContent?.includes("Agent"));
    expect(llmRows.length).toBeGreaterThanOrEqual(2);
    expect(llmRows.some((el) => el.textContent?.includes("100 tok"))).toBe(
      false,
    );
    const firstLlmRow = llmRows.find((el) => el.textContent?.includes("Agent"));
    expect(firstLlmRow).toBeTruthy();
    const firstLlmLabelButton = within(firstLlmRow!).getByTestId(
      "trace-row-label-button",
    );
    expect(firstLlmLabelButton).not.toHaveTextContent(/100 tok/);
    expect(firstLlmLabelButton).not.toHaveTextContent(/500ms/);
    const firstLlmDuration = screen
      .getAllByTestId("trace-row-duration-hit")
      .find((el) => el.textContent?.includes("500ms"));
    expect(firstLlmDuration).toBeTruthy();
    expect(firstLlmDuration).toHaveTextContent("500ms");
    expect(
      rows.some((el) => el.textContent?.includes("openai/gpt-5.4-nano")),
    ).toBe(false);
  });

  it("shows user message as prompt row label without an inline token subtitle", () => {
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
    expect(promptRow!).toHaveClass("trace-waterfall-row-selected");
    expect(within(promptRow!).getByTestId("trace-row-bar-hit")).not.toHaveClass(
      "trace-waterfall-row-selected",
    );
    const promptLabelButton = within(promptRow!).getByTestId(
      "trace-row-label-button",
    );
    expect(promptLabelButton).not.toHaveTextContent(/50 tok/);
    expect(promptLabelButton).not.toHaveTextContent(/800ms/);
    const promptDuration = screen
      .getAllByTestId("trace-row-duration-hit")
      .find((el) => el.textContent?.includes("800ms"));
    expect(promptDuration).toBeTruthy();
    expect(promptDuration).toHaveTextContent("800ms");
    expect(promptRow!.textContent).not.toMatch(/1 LLM/);
    expect(promptRow!.textContent).not.toMatch(/1 tool/);
  });

  it("reveals prompt rows using the exact user source message, even when spans start at the assistant", async () => {
    const user = userEvent.setup();
    const onRevealInTranscript = vi.fn();
    const spans: EvalTraceSpan[] = [
      {
        id: "step-1",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 400,
        promptIndex: 0,
        messageStartIndex: 1,
        messageEndIndex: 2,
      },
      {
        id: "tool-1",
        parentId: "step-1",
        name: "read_me",
        category: "tool",
        startMs: 50,
        endMs: 200,
        promptIndex: 0,
        toolName: "read_me",
        toolCallId: "call-1",
        messageStartIndex: 1,
        messageEndIndex: 2,
      },
    ];
    const transcriptMessages = [
      { role: "user" as const, content: "Draw me a diagram" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "read_me",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-1",
            toolName: "read_me",
            output: "done",
          },
        ],
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
        onRevealInTranscript={onRevealInTranscript}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    expect(onRevealInTranscript).toHaveBeenCalledWith({
      focusSourceIndex: 0,
      highlightSourceIndices: [0],
    });
  });

  it("emits canonical reveal selections for tool and llm rows", async () => {
    const user = userEvent.setup();
    const onRevealInTranscript = vi.fn();
    const spans: EvalTraceSpan[] = [
      {
        id: "step-1",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 500,
        promptIndex: 0,
        messageStartIndex: 1,
        messageEndIndex: 3,
      },
      {
        id: "tool-1",
        parentId: "step-1",
        name: "read_me",
        category: "tool",
        startMs: 50,
        endMs: 200,
        promptIndex: 0,
        toolName: "read_me",
        toolCallId: "call-1",
        messageStartIndex: 1,
        messageEndIndex: 2,
      },
      {
        id: "llm-1",
        parentId: "step-1",
        name: "Model response",
        category: "llm",
        startMs: 200,
        endMs: 500,
        promptIndex: 0,
        messageStartIndex: 1,
        messageEndIndex: 3,
      },
    ];
    const transcriptMessages = [
      { role: "user" as const, content: "Need docs" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "read_me",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-1",
            toolName: "read_me",
            output: "done",
          },
        ],
      },
      { role: "assistant" as const, content: "Summary ready" },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
        onRevealInTranscript={onRevealInTranscript}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Tool · read_me/i }));
    await user.click(screen.getByRole("button", { name: "Reveal in Chat" }));
    expect(onRevealInTranscript).toHaveBeenLastCalledWith({
      focusSourceIndex: 1,
      highlightSourceIndices: [1, 2],
    });

    await user.click(screen.getByRole("button", { name: /Agent/i }));
    await user.click(screen.getByRole("button", { name: "Reveal in Chat" }));
    expect(onRevealInTranscript).toHaveBeenLastCalledWith({
      focusSourceIndex: 1,
      highlightSourceIndices: [1, 2, 3],
    });
  });

  it("shows wall-clock timestamps and token counts in row hover metadata", async () => {
    const user = userEvent.setup();
    const traceStartedAtMs = Date.parse("2026-03-30T02:35:00.000Z");
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-1",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 400,
        promptIndex: 0,
        modelId: "openai/gpt-5.4-mini",
        inputTokens: 223,
        outputTokens: 38,
        totalTokens: 261,
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[
          { role: "user", content: "Draw me a simple flowchart" },
        ]}
        traceStartedAtMs={traceStartedAtMs}
        traceEndedAtMs={traceStartedAtMs + 400}
      />,
    );

    const promptRow = screen
      .getAllByTestId("trace-row")
      .find((el) =>
        el.textContent?.includes('User: "Draw me a simple flowchart"'),
      );
    expect(promptRow).toBeTruthy();

    await user.hover(promptRow!);

    const hoverContent = await screen.findByTestId("trace-row-hover-content");
    expect(hoverContent).toHaveAttribute("data-side", "left");

    const hoverCard = await screen.findByTestId("trace-row-hover-card");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-start"),
    ).toHaveTextContent(new Date(traceStartedAtMs).toLocaleString());
    expect(
      within(hoverCard).getByTestId("trace-row-hover-end"),
    ).toHaveTextContent(new Date(traceStartedAtMs + 400).toLocaleString());
    expect(
      within(hoverCard).getByTestId("trace-row-hover-input-tokens"),
    ).toHaveTextContent("223");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-output-tokens"),
    ).toHaveTextContent("38");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-total-tokens"),
    ).toHaveTextContent("261");
  });

  it("shows hover metadata fallbacks when timestamps or token counts are missing", async () => {
    const user = userEvent.setup();
    const spans: EvalTraceSpan[] = [
      {
        id: "tool-a",
        name: "read_me",
        category: "tool",
        startMs: 100,
        endMs: 220,
        toolName: "read_me",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[{ role: "user", content: "hi" }]}
      />,
    );

    const toolRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes("read_me"));
    expect(toolRow).toBeTruthy();

    await user.hover(toolRow!);

    const hoverCard = await screen.findByTestId("trace-row-hover-card");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-start"),
    ).toHaveTextContent("—");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-end"),
    ).toHaveTextContent("—");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-input-tokens"),
    ).toHaveTextContent("—");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-output-tokens"),
    ).toHaveTextContent("—");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-total-tokens"),
    ).toHaveTextContent("—");
  });

  it("shows step LLM token usage on tool row hover when the tool span has no token fields", async () => {
    const user = userEvent.setup();
    const traceStartedAtMs = Date.parse("2026-03-30T02:35:00.000Z");
    const spans: EvalTraceSpan[] = [
      {
        id: "step-0-llm",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 300,
        promptIndex: 0,
        stepIndex: 0,
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
      },
      {
        id: "tool-read",
        name: "read_me",
        category: "tool",
        startMs: 300,
        endMs: 350,
        promptIndex: 0,
        stepIndex: 0,
        toolName: "read_me",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[{ role: "user", content: "hi" }]}
        traceStartedAtMs={traceStartedAtMs}
        traceEndedAtMs={traceStartedAtMs + 350}
      />,
    );

    const toolRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes("read_me"));
    expect(toolRow).toBeTruthy();

    await user.hover(toolRow!);

    const hoverCard = await screen.findByTestId("trace-row-hover-card");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-input-tokens"),
    ).toHaveTextContent("50");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-output-tokens"),
    ).toHaveTextContent("12");
    expect(
      within(hoverCard).getByTestId("trace-row-hover-total-tokens"),
    ).toHaveTextContent("62");
  });

  it("LLM span INPUT includes full prior conversation (system + users), not just messages inside messageStartIndex", async () => {
    const user = userEvent.setup();
    const transcriptMessages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "first turn" },
      { role: "assistant" as const, content: "ack" },
      { role: "user" as const, content: "second turn" },
      { role: "assistant" as const, content: "final answer" },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-2",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 200,
        promptIndex: 0,
        stepIndex: 1,
        messageStartIndex: 4,
        messageEndIndex: 4,
        modelId: "anthropic/claude-3-haiku",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent:/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    const inputPreview = within(pane).getAllByTestId("json-editor")[0];
    const inputJson = inputPreview.textContent ?? "";
    expect(inputJson).toContain("You are a helpful assistant.");
    expect(inputJson).toContain("first turn");
    expect(inputJson).toContain("second turn");
    expect(inputJson).toContain("ack");
    expect(inputJson).not.toContain("final answer");
  });

  it("LLM span INPUT shows None when the span begins at assistant message index 0", async () => {
    const user = userEvent.setup();
    const transcriptMessages = [
      { role: "assistant" as const, content: "no prior context" },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-0",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 100,
        messageStartIndex: 0,
        messageEndIndex: 0,
        modelId: "openai/gpt-4",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent:/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    const inputSection = within(pane)
      .getByText("Input")
      .closest("div")?.parentElement;
    expect(inputSection).toBeTruthy();
    expect(within(inputSection!).getByText("None")).toBeInTheDocument();
  });

  it("LLM span INPUT includes tool results and prior assistant tool calls when range is only the final assistant", async () => {
    const user = userEvent.setup();
    const transcriptMessages = [
      { role: "user" as const, content: "please invoke the tool" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "lookup",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-1",
            toolName: "lookup",
            result: { content: [{ type: "text" as const, text: "lookup ok" }] },
          },
        ],
      },
      { role: "assistant" as const, content: "here is the summary" },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-after-tool",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 300,
        messageStartIndex: 3,
        messageEndIndex: 3,
        modelId: "anthropic/claude-3-haiku",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent:/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    const inputPreview = within(pane).getAllByTestId("json-editor")[0];
    const inputJson = inputPreview.textContent ?? "";
    expect(inputJson).toContain("please invoke the tool");
    expect(inputJson).toContain("lookup");
    expect(inputJson).toContain("lookup ok");
    expect(inputJson).not.toContain("here is the summary");
  });

  it("LLM span row shows Calling … when assistant message is tool-call only", () => {
    const transcriptMessages = [
      { role: "user" as const, content: "read the file" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-rm",
            toolName: "read_me",
            input: { path: "README.md" },
          },
        ],
      },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-tools-only",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 200,
        messageStartIndex: 1,
        messageEndIndex: 1,
        modelId: "anthropic/claude-3-haiku",
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Agent · Calling read_me/i }),
    ).toBeInTheDocument();
  });

  it("LLM span row prefers assistant text over tool calls in the same message", () => {
    const transcriptMessages = [
      { role: "user" as const, content: "go" },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "I'll fetch that." },
          {
            type: "tool-call" as const,
            toolCallId: "call-rm",
            toolName: "read_me",
            input: {},
          },
        ],
      },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-text-and-tool",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 200,
        messageStartIndex: 1,
        messageEndIndex: 1,
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Agent: "I'll fetch that\."/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Calling read_me/i }),
    ).not.toBeInTheDocument();
  });

  it("LLM span row lists multiple tool calls in Calling … preview", () => {
    const transcriptMessages = [
      { role: "user" as const, content: "do both" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "a",
            toolName: "read_me",
            input: {},
          },
          {
            type: "tool-call" as const,
            toolCallId: "b",
            toolName: "create_view",
            input: {},
          },
        ],
      },
    ];
    const spans: EvalTraceSpan[] = [
      {
        id: "llm-multi-tool",
        name: "Model response",
        category: "llm",
        startMs: 0,
        endMs: 200,
        messageStartIndex: 1,
        messageEndIndex: 1,
      },
    ];

    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={transcriptMessages}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /Agent · Calling read_me, create_view/i,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the selected prompt row when only span timings change (live preview)", () => {
    const spansA: EvalTraceSpan[] = [
      {
        id: "p0-step",
        name: "Step 1",
        category: "step",
        startMs: 0,
        endMs: 100,
        promptIndex: 0,
        stepIndex: 0,
        status: "ok",
      },
      {
        id: "p0-llm",
        parentId: "p0-step",
        name: "Agent",
        category: "llm",
        startMs: 0,
        endMs: 100,
        promptIndex: 0,
        stepIndex: 0,
        status: "ok",
        messageStartIndex: 0,
        messageEndIndex: 0,
      },
      {
        id: "p1-step",
        name: "Step 1",
        category: "step",
        startMs: 100,
        endMs: 200,
        promptIndex: 1,
        stepIndex: 0,
        status: "ok",
      },
      {
        id: "p1-llm",
        parentId: "p1-step",
        name: "Agent",
        category: "llm",
        startMs: 100,
        endMs: 200,
        promptIndex: 1,
        stepIndex: 0,
        status: "ok",
        messageStartIndex: 2,
        messageEndIndex: 2,
      },
    ];
    const transcript = [
      { role: "user", content: "draw a dog" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "save checkpoint" },
    ];
    const { rerender } = render(
      <TraceTimeline recordedSpans={spansA} transcriptMessages={transcript} />,
    );

    const secondPrompt = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes('User: "save checkpoint"'));
    expect(secondPrompt).toBeTruthy();
    fireEvent.click(within(secondPrompt!).getByTestId("trace-row-label-button"));
    expect(secondPrompt!).toHaveClass("trace-waterfall-row-selected");

    const spansB = spansA.map((s) => ({ ...s, endMs: s.endMs + 400 }));
    rerender(
      <TraceTimeline recordedSpans={spansB} transcriptMessages={transcript} />,
    );

    const secondAfter = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes('User: "save checkpoint"'));
    expect(secondAfter).toBeTruthy();
    expect(secondAfter!).toHaveClass("trace-waterfall-row-selected");
  });
});
