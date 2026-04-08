import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LiveTraceRawEmptyState } from "../live-trace-raw-empty";

vi.mock("../trace-raw-view", () => ({
  TraceRawView: () => <div data-testid="trace-raw-view-mock" />,
}));

describe("LiveTraceRawEmptyState", () => {
  it("renders sample caption and embedded raw JSON preview", () => {
    render(<LiveTraceRawEmptyState testId="raw-empty" />);

    const root = screen.getByTestId("raw-empty");
    expect(root).toBeInTheDocument();
    expect(
      within(root).getByTestId("raw-empty-sample-preview"),
    ).toBeInTheDocument();
    expect(within(root).getByTestId("trace-raw-view-mock")).toBeInTheDocument();
    expect(screen.getByText(/Sample raw request/i)).toBeInTheDocument();
    expect(
      screen.getByText(/system prompt, tool definitions/i),
    ).toBeInTheDocument();
  });
});
