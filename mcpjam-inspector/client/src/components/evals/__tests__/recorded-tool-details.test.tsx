import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordedToolDetails } from "../recorded-tool-details";
const trace = {
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "coffee",
          toolName: "search-products",
          input: { query: "coffee" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "coffee",
          output: {
            type: "json",
            value: {
              content: [{ type: "text", text: "found coffee" }],
              structuredContent: { count: 2 },
            },
          },
        },
      ],
    },
  ],
  spans: [
    {
      toolCallId: "coffee",
      serverId: "amazon",
      startMs: 0,
      endMs: 12,
      status: "ok",
    },
  ],
};
describe("recorded SDK tools", () => {
  it("shows server, timing, inputs and full response without AI text", async () => {
    render(
      <RecordedToolDetails
        trace={trace}
        metadata={{ sdkRecorderVersion: 1 }}
      />,
    );
    expect(screen.getByText("search-products")).toBeVisible();
    expect(screen.getByText("amazon")).toBeVisible();
    expect(screen.getByText("12.0 ms")).toBeVisible();
    await userEvent.click(screen.getByText("Inputs"));
    await userEvent.click(screen.getByText("Response"));
    expect(screen.getByText(/"query": "coffee"/)).toBeVisible();
    expect(screen.getByText(/"structuredContent"/)).toHaveTextContent(
      '"count": 2',
    );
  });
  it("distinguishes old, empty, unavailable and incomplete evidence", () => {
    const { rerender } = render(<RecordedToolDetails trace={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("older run");
    rerender(
      <RecordedToolDetails
        trace={null}
        metadata={{ sdkRecorderVersion: 1, captureCompleteness: "complete" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No tool calls recorded",
    );
    rerender(
      <RecordedToolDetails
        trace={null}
        metadata={{
          sdkRecorderVersion: 1,
          captureCompleteness: "unavailable",
          captureError: "limit exceeded",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("limit exceeded");
    rerender(
      <RecordedToolDetails
        trace={{ ...trace, messages: trace.messages.slice(0, 1) }}
        metadata={{ sdkRecorderVersion: 1, captureCompleteness: "incomplete" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "before all tool calls finished",
    );
    expect(screen.getByText("Incomplete")).toBeVisible();
    expect(screen.queryByText("Success")).toBeNull();
  });
  it("shows tool errors separately from test failures", () => {
    render(
      <RecordedToolDetails
        trace={{ ...trace, spans: [{ ...trace.spans[0], status: "error" }] }}
        error="Expected 3, got 2"
      />,
    );
    expect(screen.getByText("Tool error")).toBeVisible();
    expect(screen.getByText("Test failure")).toBeVisible();
    expect(screen.getByText("Expected 3, got 2")).toBeVisible();
  });
});
