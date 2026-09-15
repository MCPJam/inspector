import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration } from "../../evals/types";
import {
  RunExecutionIssues,
  summarizeRunExecutionIssues,
} from "../run-execution-issues";

const QUOTA_ERROR =
  "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 220 minutes.";
function iteration(
  id: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: "run-a",
    testCaseId: "case-a",
    createdBy: "user",
    createdAt: 0,
    updatedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "failed",
    actualToolCalls: [],
    tokensUsed: 0,
    error: QUOTA_ERROR,
    metadata: { failureCategory: "setup", stageStepErrorSource: "model" },
    ...overrides,
  };
}
const quotaRows = Array.from({ length: 15 }, (_, index) =>
  iteration(`quota-${index}`),
);
const worker = iteration("worker", {
  status: "timed_out",
  result: "timed_out",
  error: "Worker heartbeat lost.",
  metadata: { stopReason: "stale_worker" },
});

describe("recorded execution issues", () => {
  it("explains the real 15 quota failures and one lost worker with evidence navigation", async () => {
    const user = userEvent.setup();
    const onOpenIteration = vi.fn();
    const summary = summarizeRunExecutionIssues({
      suiteRunId: "run-a",
      iterations: [...quotaRows, worker],
      expectedTotal: 16,
    })!;
    render(
      <RunExecutionIssues
        summary={summary}
        onOpenIteration={onOpenIteration}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Execution errors in all 16 iterations",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/Zero model tokens and zero tool calls were recorded/),
    ).toBeVisible();
    expect(
      screen.getByText("MCPJam model limit reached · 15 of 16 iterations"),
    ).toBeVisible();
    expect(
      screen.getByText("Worker heartbeat lost · 1 of 16 iterations"),
    ).toBeVisible();
    expect(screen.getByText(`Recorded error: ${QUOTA_ERROR}`)).toBeVisible();
    expect(
      screen.getByText(/use your own model API key \(BYOK\)/),
    ).toBeVisible();
    // The affected iterations are named on the card, not hidden in a
    // disclosure: an execution error a reader cannot locate is not evidence.
    const lists = screen.getAllByTestId("affected-iterations");
    const workerList = lists[lists.length - 1]!;
    expect(within(workerList).getByText("Worker heartbeat lost.")).toBeVisible();
    await user.click(
      within(workerList).getByRole("button", { name: /^Open/ }),
    );
    expect(onOpenIteration).toHaveBeenCalledExactlyOnceWith("worker");
  });

  it("counts only the selected run and deduplicates repeated iteration records", () => {
    const summary = summarizeRunExecutionIssues({
      suiteRunId: "run-a",
      iterations: [
        quotaRows[0],
        quotaRows[0],
        worker,
        iteration("foreign", { suiteRunId: "run-b" }),
      ],
      expectedTotal: 3,
    })!;
    expect(summary).toMatchObject({
      total: 3,
      affected: 2,
      complete: false,
      noModelOrToolActivity: false,
    });
    expect(summary.groups.map((group) => group.iterations.length)).toEqual([
      1, 1,
    ]);
    render(<RunExecutionIssues summary={summary} />);
    expect(
      screen.getByText(/Some iteration records are still missing/),
    ).toBeVisible();
    expect(screen.queryByText(/Zero model tokens/)).toBeNull();
  });

  it("does not interpret assertion failures, running attempts, or successful negative tests as execution errors", () => {
    const rows = [
      iteration("assertion", {
        metadata: { failureCategory: "contract" },
        error: "Expected tool was never called",
      }),
      iteration("running", { status: "running", result: "pending" }),
      iteration("passed", { result: "passed" }),
      iteration("tool", {
        metadata: { stageStepErrorSource: "tool" },
        error: QUOTA_ERROR,
      }),
    ];
    expect(
      summarizeRunExecutionIssues({ suiteRunId: "run-a", iterations: rows }),
    ).toBeNull();
  });

  it("keeps errors specific and does not claim zero activity when some work ran", () => {
    const summary = summarizeRunExecutionIssues({
      suiteRunId: "run-a",
      iterations: [
        iteration("provider", {
          error: "Provider connection failed",
          tokensUsed: 15,
        }),
        iteration("setup", {
          status: "setup_failed",
          metadata: {},
          error: "Environment unavailable",
        }),
        iteration("passed", { result: "passed", tokensUsed: 10 }),
      ],
    })!;
    expect(summary).toMatchObject({
      affected: 2,
      total: 3,
      noModelOrToolActivity: false,
    });
    expect(summary.groups.map((group) => group.kind)).toEqual([
      "model_unknown",
      "setup_error",
    ]);
  });

  it("does not infer zero usage when the recorded metrics are absent", () => {
    const missing = iteration("missing");
    Reflect.deleteProperty(missing, "tokensUsed");
    Reflect.deleteProperty(missing, "actualToolCalls");
    expect(
      summarizeRunExecutionIssues({
        suiteRunId: "run-a",
        iterations: [missing],
      })?.noModelOrToolActivity,
    ).toBe(false);
  });

  it("shows plain, bounded, redacted error evidence and no dead navigation", async () => {
    const user = userEvent.setup();
    const summary = summarizeRunExecutionIssues({
      suiteRunId: "run-a",
      iterations: [
        iteration("redacted", {
          testCaseId: undefined,
          error:
            "Provider failed: Authorization: Bearer secret-canary-value <script>alert(1)</script> " +
            "x".repeat(800),
        }),
      ],
    })!;
    const { container } = render(
      <RunExecutionIssues summary={summary} onOpenIteration={vi.fn()} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("secret-canary-value");
    expect(container.textContent).not.toContain("x".repeat(501));
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });
});

it.each([
  ["mcpjam", "mcpjam_model_error"],
  ["byok", "model_error"],
  ["local_byok", "model_error"],
  [undefined, "model_unknown"],
])("attributes model ownership %s", (modelSource, kind) => {
  const summary = summarizeRunExecutionIssues({
    suiteRunId: "run-a",
    iterations: [
      iteration("empty", {
        error:
          "Backend step returned no content (stream error or empty response)",
        metadata: { stageStepErrorSource: "model", modelSource },
      }),
    ],
  })!;
  expect(summary.groups[0].kind).toBe(kind);
  render(<RunExecutionIssues summary={summary} />);
  expect(
    screen.getAllByText(/The model returned no response/).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/Backend step returned/)).toBeNull();
});
