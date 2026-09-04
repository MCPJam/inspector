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
      stageStates: {
        connection: { kind: "passed", count: 10 },
        discovery: { kind: "passed", count: 10 },
        selection: { kind: "failed", count: 3 },
        call: {
          kind: "partial",
          passed: 6,
          notReached: 3,
          notMeasured: 1,
          notApplicable: 0,
        },
        response: {
          kind: "partial",
          passed: 6,
          notReached: 4,
          notMeasured: 0,
          notApplicable: 0,
        },
        userValue: { kind: "notMeasured", count: 10 },
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
      within(legacy).queryByLabelText("No verdict read for this case"),
    ).toBeNull();
    expect(within(legacy).queryByLabelText(/Case verdict/)).toBeNull();
    // And it says why, so the missing mark is an answer rather than a gap.
    expect(legacy).toHaveTextContent("counted in iterations");
    expect(
      within(legacy).getByRole("button", { name: /Draw a rectangle/ }),
    ).toHaveAttribute("aria-expanded", "false");
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

  it("never paints a stage green that the run did not reach", () => {
    // The bug this replaced: any stage with zero breaks rendered solid green,
    // so a case that stopped at Selection showed Call, Response and User value
    // as passing — three stages it never measured.
    render(
      <RunCaseRows
        rows={[
          row({
            coverage: {
              ...row().coverage,
              stageStates: {
                connection: { kind: "passed", count: 1 },
                discovery: { kind: "passed", count: 1 },
                selection: { kind: "failed", count: 1 },
                call: { kind: "notReached", count: 1 },
                response: { kind: "notReached", count: 1 },
                userValue: { kind: "notMeasured", count: 1 },
              },
            },
          }),
        ]}
        defaultOpenKey={null}
      />,
    );

    expect(screen.getByTitle("Tool call: never reached")).toBeInTheDocument();
    expect(screen.getByTitle("Response: never reached")).toBeInTheDocument();
    expect(screen.getByTitle("User value: not measured")).toBeInTheDocument();
    // And nothing claims a pass for them.
    expect(screen.queryByTitle(/Tool call: passed/)).toBeNull();
  });

  it("splits a stage some iterations reached and others did not", () => {
    render(<RunCaseRows rows={[row()]} defaultOpenKey={null} />);
    // The three non-passing shapes stay apart: a chain that arrived and
    // decided nothing is a different fact from one that stopped earlier, and
    // summing them into "never reached it" asserts the wrong one about three.
    expect(
      screen.getByTitle(
        "Tool call: passed in 6 of 10, 3 never reached it, 1 not measured",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("Response: passed in 6 of 10, 4 never reached it"),
    ).toBeInTheDocument();
  });

  it("opens the failing row when the nomination arrives after first render", async () => {
    // The rows land only once the decision read resolves, so the FIRST render
    // has no failing row to nominate. `useState` would keep that initial null
    // forever and the failing case would render closed on every real run.
    const { rerender } = render(
      <RunCaseRows rows={[row()]} defaultOpenKey={null} />,
    );
    expect(screen.queryByTestId("run-case-row-body")).toBeNull();

    rerender(<RunCaseRows rows={[row()]} defaultOpenKey="g1" />);
    await screen.findByTestId("run-case-row-body");
  });

  it("says so plainly when a run has no cases", () => {
    render(<RunCaseRows rows={[]} defaultOpenKey={null} />);
    expect(
      screen.getByText("This run has no cases to show."),
    ).toBeInTheDocument();
  });
});
