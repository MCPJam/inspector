import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvaluateRunCompare } from "../evaluate-run-compare";
import type { EvalSuiteRun } from "../../evals/types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    namedHostId: "host-1",
    summary: { total: 3, passed: 2, failed: 1, passRate: 67 },
    ...overrides,
  };
}

const hostNamesById = new Map<string, string | null>([["host-1", "Claude"]]);

describe("EvaluateRunCompare", () => {
  it("defaults to the previous run and confirms that id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <EvaluateRunCompare
        thisRun={makeRun({ _id: "this-run" })}
        otherRuns={[
          makeRun({ _id: "older-run", createdAt: 1 }),
          makeRun({ _id: "prev-run", createdAt: 2 }),
        ]}
        defaultOtherRunId="prev-run"
        hostNamesById={hostNamesById}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("evaluate-run-compare-option-prev-run"),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByTestId("evaluate-run-compare-confirm"));
    expect(onSelect).toHaveBeenCalledWith("prev-run");
  });

  it("lets the reader pick a different run before confirming", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <EvaluateRunCompare
        thisRun={makeRun({ _id: "this-run" })}
        otherRuns={[
          makeRun({ _id: "older-run" }),
          makeRun({ _id: "prev-run" }),
        ]}
        defaultOtherRunId="prev-run"
        hostNamesById={hostNamesById}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );

    await user.click(
      screen.getByTestId("evaluate-run-compare-option-older-run"),
    );
    await user.click(screen.getByTestId("evaluate-run-compare-confirm"));
    expect(onSelect).toHaveBeenCalledWith("older-run");
  });

  it("formats a fractional passRate as a percent", () => {
    render(
      <EvaluateRunCompare
        thisRun={makeRun({ _id: "this-run" })}
        otherRuns={[
          makeRun({
            _id: "prev-run",
            summary: { total: 3, passed: 2, failed: 1, passRate: 2 / 3 },
          }),
        ]}
        defaultOtherRunId="prev-run"
        hostNamesById={hostNamesById}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("evaluate-run-compare-option-prev-run"),
    ).toHaveTextContent("67%");
  });

  it("cancels without selecting", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onSelect = vi.fn();

    render(
      <EvaluateRunCompare
        thisRun={makeRun({ _id: "this-run" })}
        otherRuns={[makeRun({ _id: "prev-run" })]}
        defaultOtherRunId="prev-run"
        hostNamesById={hostNamesById}
        onSelect={onSelect}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
