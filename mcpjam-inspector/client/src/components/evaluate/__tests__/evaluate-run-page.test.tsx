import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvaluateRunPage } from "../evaluate-run-page";
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

describe("EvaluateRunPage", () => {
  it("shows this run and no All-runs rail", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "n57cvtk9tsmnbj5tpcvnmdgkwn8dnjeq" })}
        hostNamesById={hostNamesById}
        otherRuns={[makeRun({ _id: "other-run" })]}
        defaultCompareRunId="other-run"
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByTestId("evaluate-run-page")).toHaveTextContent(
      "Run n57cvtk9",
    );
    expect(screen.getByText("run body")).toBeTruthy();
    expect(screen.queryByText("All runs")).toBeNull();
    expect(screen.queryByText("latest + trends per client")).toBeNull();
    expect(screen.getByTestId("evaluate-run-compare-open")).toBeEnabled();
  });

  it("disables Compare when there is no other run", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "only-run" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    const compare = screen.getByTestId("evaluate-run-compare-open");
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute("title", "Need at least two runs");
  });

  it("opens the compare picker and confirms the default other run", async () => {
    const user = userEvent.setup();
    const onCompareWithRun = vi.fn();

    render(
      <EvaluateRunPage
        run={makeRun({ _id: "this-run" })}
        hostNamesById={hostNamesById}
        otherRuns={[makeRun({ _id: "prev-run", summary: { total: 3, passed: 2, failed: 1, passRate: 67 } })]}
        defaultCompareRunId="prev-run"
        onCompareWithRun={onCompareWithRun}
        onExport={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    await user.click(screen.getByTestId("evaluate-run-compare-open"));
    expect(screen.getByTestId("evaluate-run-compare")).toBeTruthy();
    expect(screen.queryByText("run body")).toBeNull();

    await user.click(screen.getByTestId("evaluate-run-compare-confirm"));
    expect(onCompareWithRun).toHaveBeenCalledWith("prev-run");
  });
});
