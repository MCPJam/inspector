import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { EvalSuiteRun } from "@/components/evals/types";
import { LaunchedCaseJudge } from "../case-scorecard/launched-case-judge";

const { query, request, errorToast } = vi.hoisted(() => ({
  query: vi.fn(),
  request: vi.fn(),
  errorToast: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: query,
  useMutation: () => request,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: errorToast } }));

const run = (overrides: Partial<EvalSuiteRun> = {}) =>
  ({
    _id: "new-run",
    status: "completed",
    ...overrides,
  }) as EvalSuiteRun;

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue(undefined);
  query.mockReturnValue(run({ status: "running" }));
});

describe("judging runs launched by Run test", () => {
  it("waits for completion and requests once even under Strict Mode", async () => {
    const view = render(
      <StrictMode>
        <LaunchedCaseJudge runId="new-run" />
      </StrictMode>,
    );
    expect(query).toHaveBeenCalledWith("testSuites:getTestSuiteRun", {
      runId: "new-run",
    });
    expect(request).not.toHaveBeenCalled();
    query.mockReturnValue(run());
    view.rerender(
      <StrictMode>
        <LaunchedCaseJudge runId="new-run" />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ suiteRunId: "new-run" }),
    );
    view.rerender(
      <StrictMode>
        <LaunchedCaseJudge runId="new-run" />
      </StrictMode>,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not judge an older selected run while the new run loads", () => {
    query.mockReturnValue(run({ _id: "old-run" }));
    render(<LaunchedCaseJudge runId="new-run" />);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { goalCompletionStatus: "pending" },
    { goalCompletionStatus: "completed" },
    { goalCompletionStatus: "failed" },
    { status: "grading" },
    { status: "cancelled" },
    { configSnapshot: { judgeConfig: { goalCompletion: { enabled: false } } } },
    { configSnapshot: { judgeConfig: { goalCompletion: { autoRun: true } } } },
  ])("leaves existing or disabled judge work alone: %j", (overrides) => {
    query.mockReturnValue(run(overrides as Partial<EvalSuiteRun>));
    render(<LaunchedCaseJudge runId="new-run" />);
    expect(request).not.toHaveBeenCalled();
  });

  it("tracks each fanout run independently of which trial is displayed", async () => {
    query.mockImplementation((_name, { runId }) => run({ _id: runId }));
    render(
      <>
        <LaunchedCaseJudge runId="host-a" />
        <LaunchedCaseJudge runId="host-b" />
      </>,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith({ suiteRunId: "host-a" });
    expect(request).toHaveBeenCalledWith({ suiteRunId: "host-b" });
  });

  it("reports request failures without repeatedly spending on retries", async () => {
    query.mockReturnValue(run());
    request.mockRejectedValue(new Error("Judge limit reached"));
    const view = render(<LaunchedCaseJudge runId="new-run" />);
    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    view.rerender(<LaunchedCaseJudge runId="new-run" />);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
