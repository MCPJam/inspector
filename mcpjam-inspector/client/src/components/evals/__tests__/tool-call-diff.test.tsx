import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallDiff } from "../tool-call-diff";
import { evaluateToolCalls } from "@/shared/eval-matching";

const tc = (toolName: string, args: Record<string, unknown> = {}) => ({
  toolName,
  arguments: args,
});

describe("ToolCallDiff", () => {
  it("renders nothing when there are no mismatches", () => {
    const result = evaluateToolCalls([tc("a")], [tc("a")]);
    const { container } = render(<ToolCallDiff result={result} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Missing section when a call was expected but not made", () => {
    const result = evaluateToolCalls([tc("search"), tc("save")], [tc("search")]);
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("save")).toBeInTheDocument();
  });

  it("renders Extra section when an actual call is unexpected", () => {
    const result = evaluateToolCalls([tc("a")], [tc("a"), tc("b")]);
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("Extra")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("reports reversed actuals as Missing under strict order", () => {
    // After the trajectory-mode refactor, `strict` is index-aligned: it
    // never pairs expected[i] with actual[j] when i ≠ j, so reversed
    // actuals appear as missing (the canonical "this call did not happen
    // at the right step") rather than out-of-order pairings. The
    // outOfOrder result field stays empty by construction.
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
      { toolCallOrder: "strict" },
    );
    expect(result.outOfOrder).toEqual([]);
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("Missing")).toBeInTheDocument();
  });

  it("renders Arg mismatch with side-by-side expected vs actual", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1, b: 2 })],
      [tc("add", { a: 1, b: 99 })],
    );
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("Arg mismatch")).toBeInTheDocument();
    expect(screen.getAllByText(/expected/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/actual/i).length).toBeGreaterThan(0);
  });

  it("shows a PASS badge when result.passed is true", () => {
    const result = evaluateToolCalls([tc("a")], [tc("a"), tc("extra")]);
    expect(result.passed).toBe(true);
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
  });

  it("shows a FAIL badge when result.passed is false", () => {
    const result = evaluateToolCalls([tc("a")], [tc("b")]);
    expect(result.passed).toBe(false);
    render(<ToolCallDiff result={result} />);
    expect(screen.getByText("FAIL")).toBeInTheDocument();
  });
});
