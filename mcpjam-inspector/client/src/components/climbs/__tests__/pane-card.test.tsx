import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useEvalTraceBlob = vi.fn();
vi.mock("../../evals/use-eval-trace-blob", () => ({ useEvalTraceBlob: (...a: unknown[]) => useEvalTraceBlob(...a) }));
vi.mock("../../evals/trace-viewer", () => ({
  TraceViewer: ({ trace }: { trace: { id: string } }) => <div data-testid="trace">{trace.id}</div>,
}));

import { PaneCard, iterationPassed } from "../pane-card";

const iteration = (extra: object = {}) =>
  ({ _id: "i1", result: "failed", actualToolCalls: [{}, {}], usage: { totalTokens: 1200 }, ...extra }) as never;

describe("PaneCard", () => {
  it("shows the transcript, whether the iteration passed, and its tool calls", () => {
    useEvalTraceBlob.mockReturnValue({ blob: { id: "trace-1" }, loading: false, error: null });
    render(<PaneCard pane={{ letter: "C", title: "This change", sub: "Claude Code", iteration: iteration() }} />);
    expect(screen.getByTestId("trace")).toHaveTextContent("trace-1");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("2 tool calls · 1,200 tokens")).toBeInTheDocument();
  });
  it("says while it loads, and what to do when it fails", () => {
    useEvalTraceBlob.mockReturnValue({ blob: null, loading: true, error: null });
    const { rerender } = render(<PaneCard pane={{ title: "A", sub: "", iteration: iteration() }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the transcript.");
    useEvalTraceBlob.mockReturnValue({ blob: null, loading: false, error: "Failed to load trace" });
    rerender(<PaneCard pane={{ title: "A", sub: "", iteration: iteration() }} />);
    expect(screen.getByText(/Failed to load trace Reload the page to try again/)).toBeInTheDocument();
  });
  it("says when the run has no iteration of the case", () => {
    render(<PaneCard pane={{ title: "A", sub: "" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("no iteration of this case");
    render(<PaneCard pane={{ title: "B", sub: "", loading: true }} />);
    expect(screen.getByText("Loading the run.")).toBeInTheDocument();
  });
  it("reads pass from the iteration's result", () => {
    expect(iterationPassed(iteration({ result: "passed" }))).toBe(true);
    expect(iterationPassed(iteration({ result: "pending" }))).toBeUndefined();
    expect(iterationPassed(undefined)).toBeUndefined();
  });
});
