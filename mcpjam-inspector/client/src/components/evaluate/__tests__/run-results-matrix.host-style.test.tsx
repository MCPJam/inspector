import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunResultsMatrix } from "../run-results-matrix";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

vi.mock("../../evals/iteration-details", () => ({
  IterationDetails: ({
    hostSnapshot,
  }: {
    hostSnapshot: { hostStyle: string } | null;
  }) => (
    <output data-testid="iteration-host">
      {hostSnapshot?.hostStyle ?? "unavailable"}
    </output>
  ),
}));

describe("Evaluate trial drawer host wiring", () => {
  it.each(["claude", "chatgpt", "codex"])(
    "passes the selected run's %s style",
    async (hostStyle) => {
      const run = {
        _id: "run-1",
        suiteId: "suite",
        runNumber: 1,
        status: "completed",
        effectiveModelId: "model-1",
        client: {
          name: "Test client",
          hostStyle,
          source: "named_host",
          namedHostId: "host-1",
          versionId: "config-1",
        },
        configSnapshot: { tests: [], environment: { servers: [] } },
      } as unknown as EvalSuiteRun;
      const iteration = {
        _id: "trial-1",
        suiteRunId: "run-1",
        testCaseId: "case-1",
        status: "completed",
        result: "passed",
        actualToolCalls: [],
        updatedAt: 2,
        startedAt: 1,
        testCaseSnapshot: {
          title: "Inspect order",
          model: "model-1",
          provider: "custom",
          query: "Inspect the order",
          expectedToolCalls: [],
        },
      } as EvalIteration;
      const user = userEvent.setup();
      render(
        <RunResultsMatrix
          run={run}
          iterations={[iteration]}
          hostNamesById={new Map()}
        />,
      );
      await user.click(
        screen.getByRole("button", { name: /Inspect Inspect order on/ }),
      );
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Open iteration 1 details",
        }),
      );
      expect(screen.getByTestId("iteration-host")).toHaveTextContent(hostStyle);
    },
  );
});
