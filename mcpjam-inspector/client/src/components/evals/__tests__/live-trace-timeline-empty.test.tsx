import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LiveTraceTimelineEmptyState } from "../live-trace-timeline-empty";

vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer-mock" />,
}));

describe("LiveTraceTimelineEmptyState", () => {
  it("renders sample caption and embedded sample trace preview", () => {
    render(<LiveTraceTimelineEmptyState testId="timeline-empty" />);

    const root = screen.getByTestId("timeline-empty");
    expect(root).toBeInTheDocument();
    expect(
      within(root).getByTestId("timeline-empty-sample-preview"),
    ).toBeInTheDocument();
    expect(within(root).getByTestId("trace-viewer-mock")).toBeInTheDocument();
    expect(screen.getByText(/Sample trace/i)).toBeInTheDocument();
    expect(screen.getByText(/Evaluate → Runs/i)).toBeInTheDocument();
  });
});
