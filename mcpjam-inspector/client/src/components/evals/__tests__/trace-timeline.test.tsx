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
});
