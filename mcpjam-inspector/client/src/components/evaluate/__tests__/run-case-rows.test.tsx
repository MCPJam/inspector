/**
 * What a case row shows, and what it refuses to colour.
 *
 * The model decides all of this; these tests pin that the view does not undo
 * it — most importantly that a row with no verdict gets no verdict glyph, and
 * that the iteration fraction never stands in for one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { RunCaseRows } from "../run-case-rows";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";

function row(overrides: Partial<EvaluateCaseRow> = {}): EvaluateCaseRow {
  return {
    key: "g1",
    title: "Draw and share a diagram",
    testCaseId: "tc_1",
    iterations: { passed: 6, total: 10 },
    verdict: { kind: "matched", variants: [] },
    mark: "failed",
    break: { kind: "brokeAt", stage: "selection", reason: "missingToolCall" },
    cells: Array.from({ length: 10 }, (_, index) => ({
      iterationId: `it_${index}`,
      outcome: index % 3 === 0 ? "failed" : "passed",
      stage: index % 3 === 0 ? "selection" : null,
    })),
    coverage: {
      total: 10,
      loaded: 10,
      breaksByStage: {
        connection: 0,
        discovery: 0,
        selection: 3,
        call: 1,
        response: 0,
        userValue: 0,
      },
      withheld: 0,
      note: null,
    },
    p50Ms: 13800,
    opensIterationId: "it_0",
    diagnostic: null,
    ...overrides,
  } as EvaluateCaseRow;
}

afterEach(cleanup);

describe("RunCaseRows", () => {
  it("names the case, the break and the iteration fraction", () => {
    render(<RunCaseRows rows={[row()]} defaultOpenKey={null} />);

    const rendered = screen.getByTestId("run-case-row-g1");
    expect(rendered).toHaveTextContent("Draw and share a diagram");
    expect(rendered).toHaveTextContent(
      "Broke at Selection: an expected tool call was never made",
    );
    expect(rendered).toHaveTextContent("6/10");
  });

  it("paints a verdict glyph only when a verdict was read", () => {
    render(
      <RunCaseRows
        rows={[
          row(),
          row({
            key: "g2",
            title: "Draw a rectangle",
            mark: null,
            verdict: { kind: "legacyRun" },
            iterations: { passed: 1, total: 1 },
            cells: [{ iterationId: "x", outcome: "passed", stage: null }],
            break: { kind: "none" },
          }),
        ]}
        defaultOpenKey={null}
      />,
    );

    expect(
      within(screen.getByTestId("run-case-row-g1")).getByLabelText(
        "Case verdict: failed",
      ),
    ).toBeInTheDocument();

    const legacy = screen.getByTestId("run-case-row-g2");
    expect(
      within(legacy).getByLabelText("No verdict read for this case"),
    ).toBeInTheDocument();
    // And it says why, so the missing mark is an answer rather than a gap.
    expect(legacy).toHaveTextContent("counted in iterations");
  });

  it("hides the fraction for a case that ran once", () => {
    // 1/1 alongside 10/10 invites reading them as equally strong evidence.
    render(
      <RunCaseRows
        rows={[
          row({
            iterations: { passed: 1, total: 1 },
            cells: [{ iterationId: "x", outcome: "passed", stage: null }],
          }),
        ]}
        defaultOpenKey={null}
      />,
    );
    expect(screen.getByTestId("run-case-row-g1")).not.toHaveTextContent("1/1");
  });

  it("opens the row the model nominated", () => {
    render(<RunCaseRows rows={[row()]} defaultOpenKey="g1" />);
    expect(screen.getByTestId("run-case-row-body")).toBeInTheDocument();
  });

  it("states partial chain coverage instead of implying clean stages", () => {
    render(
      <RunCaseRows
        rows={[
          row({
            coverage: {
              ...row().coverage,
              loaded: 8,
              note: "chains loaded for 8 of 10 iterations",
            },
          }),
        ]}
        defaultOpenKey={null}
      />,
    );
    expect(screen.getByTestId("run-case-row-g1")).toHaveTextContent(
      "chains loaded for 8 of 10 iterations",
    );
  });

  it("offers the iteration link only with somewhere to send the reader", () => {
    const onOpenIteration = vi.fn();
    render(
      <RunCaseRows
        rows={[row({ testCaseId: null })]}
        defaultOpenKey="g1"
        onOpenIteration={onOpenIteration}
      />,
    );
    expect(screen.queryByText("Open this iteration")).toBeNull();
  });

  it("says so plainly when a run has no cases", () => {
    render(<RunCaseRows rows={[]} defaultOpenKey={null} />);
    expect(
      screen.getByText("This run has no cases to show."),
    ).toBeInTheDocument();
  });
});
