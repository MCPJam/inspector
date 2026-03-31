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

  it("labels generic LLM spans as Model and keeps tokens out of the inline row text", () => {
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
      el.textContent?.includes("Model"),
    );
    expect(llmRows.length).toBeGreaterThanOrEqual(2);
    expect(llmRows.some((el) => el.textContent?.includes("100 tok"))).toBe(false);
    const firstLlmRow = llmRows.find(
      (el) => el.textContent?.includes("Model"),
    );
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
    expect(rows.some((el) => el.textContent?.includes("openai/gpt-5.4-nano"))).toBe(false);
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
    const promptLabelButton = within(promptRow!).getByTestId("trace-row-label-button");
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
        transcriptMessages={[{ role: "user", content: "Draw me a simple flowchart" }]}
        traceStartedAtMs={traceStartedAtMs}
        traceEndedAtMs={traceStartedAtMs + 400}
      />,
    );

    const promptRow = screen
      .getAllByTestId("trace-row")
      .find((el) => el.textContent?.includes('User: "Draw me a simple flowchart"'));
    expect(promptRow).toBeTruthy();

    await user.hover(promptRow!);

    const hoverContent = await screen.findByTestId("trace-row-hover-content");
    expect(hoverContent).toHaveAttribute("data-side", "left");

    const hoverCard = await screen.findByTestId("trace-row-hover-card");
    expect(within(hoverCard).getByTestId("trace-row-hover-start")).toHaveTextContent(
      new Date(traceStartedAtMs).toLocaleString(),
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-end")).toHaveTextContent(
      new Date(traceStartedAtMs + 400).toLocaleString(),
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-input-tokens")).toHaveTextContent(
      "223",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-output-tokens")).toHaveTextContent(
      "38",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-total-tokens")).toHaveTextContent(
      "261",
    );
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
    expect(within(hoverCard).getByTestId("trace-row-hover-start")).toHaveTextContent(
      "—",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-end")).toHaveTextContent(
      "—",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-input-tokens")).toHaveTextContent(
      "—",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-output-tokens")).toHaveTextContent(
      "—",
    );
    expect(within(hoverCard).getByTestId("trace-row-hover-total-tokens")).toHaveTextContent(
      "—",
    );
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

    await user.click(
      screen.getByRole("button", { name: /Model:/i }),
    );
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
      <TraceTimeline recordedSpans={spans} transcriptMessages={transcriptMessages} />,
    );

    await user.click(screen.getByRole("button", { name: /Model:/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    const inputSection = within(pane).getByText("Input").closest("div")
      ?.parentElement;
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
      <TraceTimeline recordedSpans={spans} transcriptMessages={transcriptMessages} />,
    );

    await user.click(screen.getByRole("button", { name: /Model:/i }));
    const pane = screen.getByTestId("trace-detail-pane");
    const inputPreview = within(pane).getAllByTestId("json-editor")[0];
    const inputJson = inputPreview.textContent ?? "";
    expect(inputJson).toContain("please invoke the tool");
    expect(inputJson).toContain("lookup");
    expect(inputJson).toContain("lookup ok");
    expect(inputJson).not.toContain("here is the summary");
  });
});
