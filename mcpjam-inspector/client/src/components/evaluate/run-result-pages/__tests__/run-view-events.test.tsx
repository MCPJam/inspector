import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunResultsMatrix } from "../../run-results-matrix";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import {
  trackCaseResultViewed,
  trackIterationViewed,
  trackRunViewed,
} from "../run-view-events";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useConvex: () => ({ query: async () => null }),
  useQueries: () => ({}),
  useQuery: () => undefined,
}));

const ref = { suiteId: "suite", runId: "one" };

function run(id: string, namedHostId = "claude"): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId,
    effectiveModelId: "sonnet",
    runNumber: 3,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
  } as EvalSuiteRun;
}

function iteration(id: string, runId: string): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "refund",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 500,
    actualToolCalls: [],
    startedAt: 1000,
    updatedAt: 2000,
    testCaseSnapshot: {
      title: "Refund order",
      model: "sonnet",
      provider: "anthropic",
      query: "Refund the order",
      expectedToolCalls: [],
    },
  } as EvalIteration;
}

describe("run view events", () => {
  beforeEach(() => track.mockClear());

  it("names the suite and run on every event", () => {
    trackRunViewed(ref, "grid");
    trackCaseResultViewed(ref, "page");
    trackIterationViewed(ref, "page", "pager");

    expect(track.mock.calls).toEqual([
      [
        "eval_run_viewed",
        {
          location: "evaluate_tab",
          suite_id: "suite",
          run_id: "one",
          surface: "grid",
        },
      ],
      [
        "eval_case_result_viewed",
        {
          location: "evaluate_tab",
          suite_id: "suite",
          run_id: "one",
          surface: "page",
        },
      ],
      [
        "eval_iteration_viewed",
        {
          location: "evaluate_tab",
          suite_id: "suite",
          run_id: "one",
          surface: "page",
          via: "pager",
        },
      ],
    ]);
  });

  it("records one view per drawer open", async () => {
    render(
      <RunResultsMatrix
        run={run("one")}
        iterations={[iteration("pass", "one")]}
        hostNamesById={new Map([["claude", "Claude"]])}
      />,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open iteration 1 details" }),
    );

    expect(track.mock.calls.map(([event, props]) => [event, props])).toEqual([
      [
        "eval_case_result_viewed",
        {
          location: "evaluate_tab",
          suite_id: "suite",
          run_id: "one",
          surface: "drawer",
        },
      ],
      [
        "eval_iteration_viewed",
        {
          location: "evaluate_tab",
          suite_id: "suite",
          run_id: "one",
          surface: "drawer",
          via: "grid",
        },
      ],
    ]);
  });

  it("names the open page's run for a view on a sibling run's column", async () => {
    render(
      <RunResultsMatrix
        run={run("one")}
        runs={[run("two", "cursor")]}
        iterations={[iteration("pass", "one"), iteration("other", "two")]}
        hostNamesById={
          new Map([
            ["claude", "Claude"],
            ["cursor", "Cursor"],
          ])
        }
      />,
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Cursor · sonnet",
      }),
    );

    expect(track).toHaveBeenCalledWith(
      "eval_case_result_viewed",
      expect.objectContaining({ run_id: "one", surface: "drawer" }),
    );
  });
});
