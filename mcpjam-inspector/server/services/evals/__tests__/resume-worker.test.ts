import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyResumeFailure,
  executeClaimedResume,
  reportResumeComplete,
  startEvalResumeWorker,
  type ClaimedEvalRunResume,
} from "../resume-worker";
import { logger } from "../../../utils/logger";
import { EvalWorkerShutdownError } from "../run-lease";
import { resumeAttemptNumbersFor } from "../../evals-runner";

vi.mock("../route-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createConvexClient: vi.fn(() => ({ fake: "convex" })),
}));

const claimed: ClaimedEvalRunResume = {
  runId: "run-1",
  suiteId: "suite-1",
  projectId: "proj-1",
  organizationId: "org-1",
  createdByExternalId: "user-1",
  driverToken: "drv-1",
  resumeAttempt: 1,
  resumeIterationIds: ["it-2"],
  executionDeadlineAt: 123_456,
};

function deps(overrides: {
  execute?: () => Promise<void>;
  prepareError?: Error;
  mintError?: Error;
}) {
  const cleanup = vi.fn(async () => {});
  const prepare = vi.fn(async () => {
    if (overrides.prepareError) throw overrides.prepareError;
    return {
      suiteId: "suite-1",
      runId: "run-1",
      resumeIterationCount: 1,
      execute: overrides.execute ?? (async () => {}),
      cleanup,
    };
  });
  const mintBearer = vi.fn(async () => {
    if (overrides.mintError) throw overrides.mintError;
    return "bearer-1";
  });
  const complete = vi.fn(async () => {});
  return { prepare, mintBearer, complete, cleanup };
}

describe("executeClaimedResume", () => {
  it("re-mints the creator's token, resumes with the claimed driver and deadline, and reports success", async () => {
    const d = deps({});
    await executeClaimedResume(claimed, d as any);
    expect(d.mintBearer).toHaveBeenCalledWith("user-1", "org-1");
    expect(d.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        convexAuthToken: "bearer-1",
        runId: "run-1",
        driverToken: "drv-1",
        executionDeadlineAt: 123_456,
      }),
    );
    expect(d.complete).toHaveBeenCalledWith({
      runId: "run-1",
      driverToken: "drv-1",
      ok: true,
    });
    expect(d.cleanup).toHaveBeenCalled();
  });

  it("completes without executing when nothing was requeued", async () => {
    const d = deps({});
    const execute = vi.fn(async () => {});
    d.prepare.mockResolvedValueOnce({
      suiteId: "suite-1",
      runId: "run-1",
      resumeIterationCount: 0,
      execute,
      cleanup: d.cleanup,
    });
    await executeClaimedResume(claimed, d as any);
    expect(execute).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith({
      runId: "run-1",
      driverToken: "drv-1",
      ok: true,
    });
    expect(d.cleanup).toHaveBeenCalled();
  });

  it("parks the run when the creator's token cannot be minted (lost membership)", async () => {
    const d = deps({
      mintError: new Error("delegated token exchange failed (403): no member"),
    });
    await executeClaimedResume(claimed, d as any);
    expect(d.prepare).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith({
      runId: "run-1",
      driverToken: "drv-1",
      ok: false,
      failureReason: "auth",
    });
  });

  it("parks the run when its stored server credentials no longer connect", async () => {
    const d = deps({
      prepareError: new Error("401 Unauthorized: token expired"),
    });
    await executeClaimedResume(claimed, d as any);
    expect(d.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        failureReason: expect.stringMatching(/^resume_failed/),
      }),
    );
  });

  it("reports nothing when it is shut down again mid-resume — the handback owns the run", async () => {
    const d = deps({
      execute: async () => {
        throw new EvalWorkerShutdownError();
      },
    });
    await executeClaimedResume(claimed, d as any);
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalled();
  });

  it("classifies only canonical markers", () => {
    expect(classifyResumeFailure(new Error("RUN_NOT_RESUMABLE"))).toBe(
      "not_resumable",
    );
    expect(classifyResumeFailure(new Error("billing_limit_reached"))).toBe(
      "quota_exhausted",
    );
    expect(classifyResumeFailure(new Error("quota mentioned"))).toMatch(
      /^resume_failed/,
    );
  });
});

describe("startEvalResumeWorker", () => {
  it("runs one resume at a time and drains what is waiting", async () => {
    const queue: Array<ClaimedEvalRunResume | null> = [
      claimed,
      { ...claimed, runId: "run-2" },
      null,
    ];
    const claim = vi.fn(async () => queue.shift() ?? null);
    let running = 0;
    let maxRunning = 0;
    const execute = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    const handle = startEvalResumeWorker({
      claimedBy: "test",
      claim,
      execute,
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await handle.stop();
    expect(maxRunning).toBe(1);
    expect(execute.mock.calls.map((call) => (call[0] as any).runId)).toEqual([
      "run-1",
      "run-2",
    ]);
  });
});

describe("resumeAttemptNumbersFor", () => {
  const test = {
    title: "t",
    query: "q",
    runs: 3,
    model: "m1",
    provider: "p",
    expectedToolCalls: [],
    testCaseId: "case-1",
  } as any;

  it("matches the case and model; ignores other models of a multi-model case", () => {
    expect([
      ...resumeAttemptNumbersFor(test, [
        {
          iterationId: "a",
          testCaseId: "case-1",
          iterationNumber: 2,
          model: "m1",
          provider: "p",
          trialAttempt: 1,
        },
        {
          iterationId: "b",
          testCaseId: "case-1",
          iterationNumber: 3,
          model: "m2",
          provider: "p",
        },
        { iterationId: "c", testCaseId: "case-2", iterationNumber: 1 },
      ]),
    ]).toEqual([[2, 1]]);
  });

  it("a model-free case matches by case id alone", () => {
    expect([
      ...resumeAttemptNumbersFor(
        { ...test, model: "widget-probe", provider: "none" },
        [
          {
            iterationId: "a",
            testCaseId: "case-1",
            iterationNumber: 1,
            model: "other",
          },
        ],
      ),
    ]).toEqual([[1, 0]]);
  });
});

describe("startEvalResumeWorker stop()", () => {
  it("never holds shutdown on a resume that is still running", async () => {
    let finish!: () => void;
    const execute = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const handle = startEvalResumeWorker({
      claimedBy: "test",
      claim: vi.fn(async () => claimed),
      execute,
      pollIntervalMs: 10,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    const started = Date.now();
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
    finish();
  });
});

describe("reportResumeComplete", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const respond = (status: number, body: unknown) => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
    return vi.spyOn(logger, "warn").mockImplementation(() => {});
  };
  const args = { runId: "run-1", driverToken: "drv-1", ok: true };

  it("is quiet when the backend accepts the completion", async () => {
    const warn = respond(200, {
      ok: true,
      result: { ok: true, state: "resumed" },
    });
    await reportResumeComplete(args);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the backend refuses it", async () => {
    const warn = respond(200, {
      ok: true,
      result: { ok: false, error: "superseded" },
    });
    await reportResumeComplete(args);
    expect(warn).toHaveBeenCalledWith(
      "[eval-resume] completion was not accepted",
      expect.objectContaining({
        runId: "run-1",
        status: 200,
        error: "superseded",
      }),
    );
  });

  it("warns on a rejected request", async () => {
    const warn = respond(401, { ok: false, error: "unauthorized" });
    await reportResumeComplete(args);
    expect(warn).toHaveBeenCalledWith(
      "[eval-resume] completion was not accepted",
      expect.objectContaining({ status: 401, error: "unauthorized" }),
    );
  });
});
