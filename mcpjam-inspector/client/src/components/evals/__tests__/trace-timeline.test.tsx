import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";

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
    // Selection is bound to the label button / bar, not the outer row div.
    fireEvent.click(within(toolRow!).getByRole("button"));

    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByTestId("json-editor").textContent).toContain(
      "README.md",
    );
  });

  it("shows a transcript-derived preview on step rows instead of only Prompt n", () => {
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

    const stepRow = screen
      .getByText("Step 1")
      .closest("[data-testid='trace-row']");
    expect(stepRow?.textContent).toContain("Need docs");
    expect(stepRow?.textContent).not.toContain("Prompt 1");
  });

  it("marks tool spans as failed from transcript when persisted status is ok", () => {
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
    expect(errorBar.className).toContain("bg-red-500");

    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByLabelText("Error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "ERROR" }));
    expect(
      screen
        .getAllByTestId("trace-row")
        .some((el) => el.textContent?.includes("create_view")),
    ).toBe(true);
  });
});
