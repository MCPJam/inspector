import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunComparisonPage } from "../run-comparison-page";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
const run = (id: string, runNumber: number) =>
  ({
    _id: id,
    runNumber,
    createdAt: 1000,
    completedAt: 3000,
    status: "completed",
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    namedHostId: id,
    effectiveModelId: `${id}-model`,
    configSnapshot: { tests: [], environment: { servers: ["Server"] } },
  }) as unknown as EvalSuiteRun;
const first = run("a", 1),
  second = run("b", 2);
it("aligns metrics and cases across runs and allows changing the selected runs", async () => {
  const onOpenRun = vi.fn();
  const trials = [
    {
      _id: "it",
      suiteRunId: "a",
      testCaseId: "case",
      testCaseSnapshot: { title: "Find account" },
      result: "passed",
      status: "completed",
      tokensUsed: 20,
      actualToolCalls: [],
      createdAt: 1000,
      startedAt: 1000,
      updatedAt: 2000,
    },
  ] as unknown as EvalIteration[];
  render(
    <RunComparisonPage
      currentRun={first}
      runs={[first, second]}
      iterations={trials}
      suiteName="Suite"
      hostNamesById={
        new Map([
          ["a", "Cursor"],
          ["b", "ChatGPT"],
        ])
      }
      onBack={vi.fn()}
      onOpenRun={onOpenRun}
    />,
  );
  const table = within(screen.getByRole("table", { name: "Run comparison" }));
  expect(
    table.getByRole("row", { name: /Client Cursor ChatGPT/ }),
  ).toBeVisible();
  expect(
    table.getByRole("row", { name: /Model a-model b-model/ }),
  ).toBeVisible();
  expect(table.getByRole("row", { name: /Pass rate 100% 100%/ })).toBeVisible();
  expect(
    table.getByRole("row", { name: /Find account 1\/1 passed/ }),
  ).toBeVisible();
  expect(table.getByRole("row", { name: /Cost — —/ })).toBeVisible();
  await userEvent.setup().click(table.getByRole("button", { name: "#2" }));
  expect(onOpenRun).toHaveBeenCalledWith("b");
  await userEvent
    .setup()
    .click(screen.getByRole("checkbox", { name: "#2 · ChatGPT" }));
  expect(table.queryByRole("button", { name: "#2" })).toBeNull();
});
