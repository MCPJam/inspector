/**
 * The expanded case: grouped failures, evidence, and an action per group.
 *
 * The grouping is the claim being tested. Ten iterations that missed the same
 * call are one piece of work; the body must say that rather than printing ten
 * near-identical blocks, and it must not merge two different reasons into one
 * recommendation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import { RunCaseRowBody } from "../run-case-row-body";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import type { EvalIteration } from "../../evals/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function diagnostic(
  iterationId: string,
  reason: string,
): EvalRunDecisionDiagnostic {
  return {
    iterationId,
    iterationNumber: 1,
    title: "Draw and share a diagram",
    status: "completed",
    result: "failed",
    chain: {
      status: "verified",
      analyzerVersion: 8,
      firstFailedStage: "selection",
      stages: [
        { stage: "connection", state: "passed" },
        { stage: "discovery", state: "passed" },
        { stage: "selection", state: "failed", reason },
        { stage: "call", state: "notReached" },
        { stage: "response", state: "notReached" },
        { stage: "userValue", state: "notMeasured" },
      ],
    },
    expected: { toolNames: ["create_view", "export_to_excalidraw"] },
    observed: { toolNames: ["create_view"] },
    evidence: { runId: "r", iterationId, tracePath: "/t" },
    nextAction: "review tool selection and the tool catalog",
  } as unknown as EvalRunDecisionDiagnostic;
}

function row(overrides: Partial<EvaluateCaseRow> = {}): EvaluateCaseRow {
  return {
    key: "g1",
    title: "Draw and share a diagram",
    testCaseId: "tc_1",
    iterations: { passed: 6, total: 10 },
    verdict: { kind: "matched", variants: [] },
    mark: "failed",
    break: { kind: "brokeAt", stage: "selection", reason: "missingToolCall" },
    cells: [],
    coverage: {
      total: 10,
      loaded: 10,
      breaksByStage: {
        connection: 0,
        discovery: 0,
        selection: 3,
        call: 0,
        response: 0,
        userValue: 0,
      },
      withheld: 0,
      note: null,
    },
    p50Ms: 13800,
    opensIterationId: "it_1",
    diagnostic: null,
    failureGroups: [
      {
        key: "selection::missingToolCall",
        stage: "selection",
        reason: "missingToolCall",
        iterationIds: ["it_1", "it_2", "it_3"],
        representative: diagnostic("it_1", "missingToolCall"),
      },
    ],
    ...overrides,
  } as EvaluateCaseRow;
}

const ITERATIONS = [
  {
    _id: "it_1",
    status: "completed",
    result: "failed",
    actualToolCalls: [{ toolName: "create_view", arguments: {} }],
  },
] as unknown as EvalIteration[];

afterEach(cleanup);

describe("RunCaseRowBody", () => {
  it("counts the iterations a failure shape covers", () => {
    render(<RunCaseRowBody row={row()} iterations={ITERATIONS} />);
    expect(
      screen.getByText("3 iterations broke at Selection"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("evidence below is from the first of them"),
    ).toBeInTheDocument();
  });

  it("shows expected against observed and marks what was never called", () => {
    render(<RunCaseRowBody row={row()} iterations={ITERATIONS} />);
    const marker = screen.getByText("never called");
    // The missing call is listed under Observed and marked, rather than being
    // silently absent from a list the reader would have to diff by eye. Its
    // name and the marker share one list item, so the assertion reads the item.
    expect(marker.closest("li")).toHaveTextContent(
      "export_to_excalidraw never called",
    );
  });

  it("keeps two different reasons as two recommendations", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "selection::missingToolCall",
              stage: "selection",
              reason: "missingToolCall",
              iterationIds: ["it_1", "it_2"],
              representative: diagnostic("it_1", "missingToolCall"),
            },
            {
              key: "selection::toolError",
              stage: "selection",
              reason: "toolError",
              iterationIds: ["it_3"],
              representative: diagnostic("it_3", "toolError"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(screen.getAllByText("Recommendation")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /Copy fix prompt/ }),
    ).toHaveLength(2);
  });

  it("labels a judge-scored group as something to check, not to fix", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "userValue::judgeFailed",
              stage: "userValue",
              reason: "judgeFailed",
              iterationIds: ["it_1"],
              representative: diagnostic("it_1", "judgeFailed"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(screen.getByText("Worth checking")).toBeInTheDocument();
    expect(screen.queryByText("Recommendation")).toBeNull();
  });

  it("says plainly when a group establishes nothing about the server", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "none::providerError",
              stage: null,
              reason: "providerError",
              iterationIds: ["it_1"],
              representative: diagnostic("it_1", "providerError"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(
      screen.getByText("Not an established server defect"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 iteration did not complete, and no stage/),
    ).toBeInTheDocument();
  });

  it("warns that a single iteration says nothing about consistency", () => {
    render(
      <RunCaseRowBody
        row={row({ iterations: { passed: 0, total: 1 } })}
        iterations={ITERATIONS}
      />,
    );
    const nudge = screen.getByText(/ran once/);
    expect(nudge).toBeInTheDocument();
    expect(nudge.textContent).not.toMatch(PASS_WORDS);
  });

  it("explains a case that passed only on its threshold", () => {
    render(
      <RunCaseRowBody
        row={row({
          mark: "passed",
          verdict: {
            kind: "matched",
            variants: [
              {
                aggregationKey: "k",
                verdict: "passed",
                passedTrials: 4,
                failedTrials: 1,
                configuredTrials: 5,
                effectivePassThreshold: 0.7,
                mixedVerdict: false,
              },
            ],
          },
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(
      screen.getByText(
        /passed on its threshold: 4 of 5 iterations cleared 0.7/,
      ),
    ).toBeInTheDocument();
  });
});
