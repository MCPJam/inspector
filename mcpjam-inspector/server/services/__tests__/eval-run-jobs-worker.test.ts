import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepareEvalRunMock, shouldSkipMock, disconnect } = vi.hoisted(() => ({
  prepareEvalRunMock: vi.fn(),
  shouldSkipMock: vi.fn(() => false),
  disconnect: vi.fn(async () => {}),
}));

vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: prepareEvalRunMock,
  shouldSkipExecution: shouldSkipMock,
}));
vi.mock("../../utils/v1-convex-token.js", () => ({
  getConvexBearerForDelegation: vi.fn(async () => "delegated-bearer"),
}));
vi.mock("../../routes/web/auth.js", () => ({
  createAuthorizedManager: vi.fn(async () => ({
    manager: { disconnectAllServers: disconnect },
  })),
}));
vi.mock("../../routes/v1/evals.js", () => ({
  fetchSuiteRunServerSelection: vi.fn(async () => ({
    serverIds: ["srv-1"],
    serverNames: ["Server"],
  })),
}));

import { resumeDurableRun } from "../eval-run-jobs-worker.js";

/**
 * Recovery resumes the run it claimed through `prepareEvalRun` with that
 * run's own idempotency key — so the launch dedupes onto it (the backend half,
 * `tests/convex/evalRunJobs.test.ts`, proves that creates and charges nothing)
 * — and never drives any other run.
 */

function handle() {
  return {
    claim: {
      jobId: "job-1",
      runId: "run-1",
      suiteId: "suite-1",
      gen: 2,
      attempt: 2,
      organizationId: "org-1",
      externalId: "user_1",
      idempotencyKey: "launch-1",
      inputs: JSON.stringify({
        suiteId: "suite-1",
        projectId: "proj-1",
        serverIds: ["srv-1"],
        source: "api",
      }),
    },
    stop: vi.fn(),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  shouldSkipMock.mockReturnValue(false);
});

describe("resumeDurableRun", () => {
  it("relaunches with the run's own key and executes it once", async () => {
    const execute = vi.fn(async () => {});
    prepareEvalRunMock.mockResolvedValue({ runId: "run-1", execute });
    const job = handle();

    await resumeDurableRun(job);

    expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
    expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
      suiteId: "suite-1",
      projectId: "proj-1",
      idempotencyKey: "launch-1",
      convexAuthToken: "delegated-bearer",
      suiteRerun: true,
      tests: [],
      durable: { resume: job },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it("never executes a relaunch that landed on another run", async () => {
    const execute = vi.fn(async () => {});
    prepareEvalRunMock.mockResolvedValue({ runId: "run-2", execute });
    const job = handle();

    await resumeDurableRun(job);

    expect(execute).not.toHaveBeenCalled();
    expect(job.stop).toHaveBeenCalled();
  });

  it("lets the lease lapse when the run needs no execution", async () => {
    const execute = vi.fn(async () => {});
    prepareEvalRunMock.mockResolvedValue({ runId: "run-1", execute });
    shouldSkipMock.mockReturnValue(true);
    const job = handle();

    await resumeDurableRun(job);

    expect(execute).not.toHaveBeenCalled();
    expect(job.stop).toHaveBeenCalled();
  });

  it("never throws when preparing fails", async () => {
    prepareEvalRunMock.mockRejectedValue(new Error("server down"));
    const job = handle();
    await expect(resumeDurableRun(job)).resolves.toBeUndefined();
    expect(job.stop).toHaveBeenCalled();
  });
});
