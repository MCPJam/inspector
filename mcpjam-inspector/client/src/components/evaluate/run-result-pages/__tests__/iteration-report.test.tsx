import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import { IterationReport } from "../iteration-report";

const selected = vi.hoisted(() => ({ run: null as EvalSuiteRun | null }));
vi.mock("../../../evals/use-selected-run", () => ({
  useSelectedRun: () => ({
    run: selected.run,
    isLoading: false,
    isUnavailable: false,
  }),
}));
// The full report is covered elsewhere; here it only shows that it rendered.
vi.mock("../../../evals/iteration-details", () => ({
  IterationDetails: (props: { trialVerdictWord?: string }) => (
    <div data-testid="iteration-details">{props.trialVerdictWord}</div>
  ),
}));

const run = {
  _id: "run-1",
  suiteId: "suite-1",
  runNumber: 12,
  status: "completed",
  configSnapshot: { tests: [], environment: { servers: [] } },
} as EvalSuiteRun;

function iteration(patch: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it-1",
    suiteRunId: "run-1",
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    createdBy: "u",
    createdAt: 1,
    iterationNumber: 2,
    updatedAt: 1,
    ...patch,
  };
}

function targetFor(row: EvalIteration) {
  return buildRunResultsMatrix({
    run,
    runs: [run],
    iterations: [row],
    hostNamesById: new Map(),
  }).targets[0];
}

describe("IterationReport", () => {
  afterEach(() => {
    selected.run = null;
  });

  it("shows only why, when the setup script failed and the agent never ran", () => {
    const row = iteration({
      status: "setup_failed",
      result: "failed",
      resultSource: "reported",
      metadata: {
        iterationScripts: {
          setup: { status: "failed", exitCode: 1, output: "busy" },
        },
      },
    });
    render(
      <IterationReport
        iteration={row}
        target={targetFor(row)}
        onEditScripts={vi.fn()}
      />,
    );
    expect(screen.getByTestId("iteration-setup-failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit scripts" })).toBeVisible();
    expect(screen.queryByTestId("iteration-details")).toBeNull();
  });

  it("shows the run's failed setup script on an iteration it never started", () => {
    selected.run = {
      ...run,
      scriptResults: {
        runSetup: { status: "failed", exitCode: 127, output: "not found" },
      },
    };
    const row = iteration({ status: "setup_failed", result: "failed" });
    render(<IterationReport iteration={row} target={targetFor(row)} />);
    expect(
      screen.getByText(
        "The Before the run script stopped with an error, so no iteration started.",
      ),
    ).toBeVisible();
    expect(screen.queryByTestId("iteration-details")).toBeNull();
  });

  it("reports other setup failures in full, named Setup failed", () => {
    const row = iteration({
      status: "setup_failed",
      result: "failed",
      resultSource: "reported",
    });
    render(<IterationReport iteration={row} target={targetFor(row)} />);
    expect(screen.getByTestId("iteration-details")).toHaveTextContent(
      "Setup failed",
    );
  });
});
