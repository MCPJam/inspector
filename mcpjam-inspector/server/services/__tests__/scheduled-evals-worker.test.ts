import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareEvalRun = vi.fn();

vi.mock("../../utils/v1-convex-token.js", () => ({
  getConvexBearerForDelegation: vi.fn().mockResolvedValue("bearer"),
}));
vi.mock("../../routes/v1/evals.js", () => ({
  fetchSuiteRunServerSelection: vi
    .fn()
    .mockResolvedValue({ serverIds: [], serverNames: [] }),
}));
vi.mock("../../routes/web/auth.js", () => ({
  createAuthorizedManager: vi.fn().mockResolvedValue({
    manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: (...args: unknown[]) => prepareEvalRun(...args),
  shouldSkipExecution: vi.fn(),
}));

import {
  classifyFailure,
  executeClaimedRun,
  startScheduledEvalsWorker,
} from "../scheduled-evals-worker";
import { platformFeeRefusalError } from "../evals/platform-fee-refusal";
import { logger } from "../../utils/logger";

const CLAIM = {
  triggerId: "trig-1",
  suiteId: "suite-1",
  suiteName: "Monitored Suite",
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  scheduledFor: 1700000000000,
};

function flushLoop(times = 6) {
  // The loop interleaves awaits; advancing timers + draining microtasks a few
  // times settles one or more iterations deterministically under fake timers.
  return (async () => {
    for (let i = 0; i < times; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
  })();
}

describe("executeClaimedRun setup failure", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    prepareEvalRun.mockReset();
  });

  function completion() {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(
      "https://convex.test/internal/v1/scheduled-eval-runs/complete",
    );
    return JSON.parse(init.body);
  }

  it("logs a spend-budget refusal at warn and pauses the schedule", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    prepareEvalRun.mockRejectedValueOnce(
      platformFeeRefusalError({
        data: { code: "ORGANIZATION_SPEND_BUDGET_REACHED" },
      }),
    );

    await executeClaimedRun(CLAIM);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[scheduled-evals] run setup refused",
      expect.objectContaining({
        triggerId: "trig-1",
        reason: "ORGANIZATION_SPEND_BUDGET_REACHED",
      }),
    );
    expect(completion()).toMatchObject({
      triggerId: "trig-1",
      ok: false,
      failureReason: "quota_exhausted",
    });
  });

  it("logs any other setup failure at error", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const failure = new Error("run start exploded");
    prepareEvalRun.mockRejectedValueOnce(failure);

    await executeClaimedRun(CLAIM);

    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduled-evals] run setup failed",
      failure,
      expect.objectContaining({ triggerId: "trig-1" }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[scheduled-evals] run setup refused",
      expect.anything(),
    );
    expect(completion()).toMatchObject({
      ok: false,
      failureReason: "run_create_failed: run start exploded",
    });
  });
});

describe("startScheduledEvalsWorker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("claims and executes one trigger at a time, then keeps polling", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce(CLAIM)
      .mockResolvedValue(null);
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CLAIM);
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("survives claim errors with a backoff instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(null);
    const execute = vi.fn();

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop(8);
    handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute) .not.toHaveBeenCalled();
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("backs off without executing when the backend reports the feature disabled", async () => {
    const claim = vi.fn().mockResolvedValue("disabled" as const);
    const execute = vi.fn();

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop(3);
    handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalled();
  });

  it("stop() ends the loop", async () => {
    const claim = vi.fn().mockResolvedValue(null);
    const handle = startScheduledEvalsWorker({ claim, execute: vi.fn() });
    await flushLoop(2);
    handle.stop();
    const callsAtStop = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim.mock.calls.length).toBe(callsAtStop);
  });

  it("does not start without the service credentials", async () => {
    vi.unstubAllEnvs();
    const claim = vi.fn();
    const handle = startScheduledEvalsWorker({ claim, execute: vi.fn() });
    await flushLoop(2);
    handle.stop();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("classifyFailure", () => {
  it("maps the canonical billing-limit code to quota_exhausted (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("billing_limit_reached: eval iterations")),
    ).toBe("quota_exhausted");
  });

  it("maps the org spend-budget refusal to quota_exhausted", () => {
    // Both canonical markers reach this classifier: the `/stream` wire code
    // and the launch mutation's ConvexError code. Either one must pause the
    // schedule rather than retry into the same cap next window.
    expect(classifyFailure(new Error("spend_budget_reached"))).toBe(
      "quota_exhausted",
    );
    expect(
      classifyFailure(
        new Error('{"code":"ORGANIZATION_SPEND_BUDGET_REACHED"}'),
      ),
    ).toBe("quota_exhausted");
    // The recorder's 403 names the code in `details.reason`, not its message.
    expect(
      classifyFailure(
        platformFeeRefusalError({
          data: { code: "ORGANIZATION_SPEND_BUDGET_REACHED" },
        }),
      ),
    ).toBe("quota_exhausted");
  });

  it("does not pause on an unrelated error that merely mentions a budget", () => {
    // The loose-substring failure mode this classifier exists to avoid: an
    // MCP server error naming "budget" is a plain failure, not a cap.
    expect(classifyFailure(new Error("tool failed: budget lookup"))).toMatch(
      /^run_create_failed:/,
    );
  });

  it("maps delegated-mint 401/403 failures to auth (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("Delegated token exchange failed (403)")),
    ).toBe("auth");
    expect(
      classifyFailure(new Error("Delegated token exchange failed (401)")),
    ).toBe("auth");
  });

  it("does NOT pause on loose substring matches (retryable failures stay retryable)", () => {
    // An MCP server error merely mentioning these words must not pause
    // the schedule.
    expect(
      classifyFailure(new Error("server replied: quota header missing")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("upstream FORBIDDEN while fetching tools")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("user is not a member of channel #general")),
    ).toMatch(/^run_create_failed: /);
  });

  it("falls back to a bounded run_create_failed reason", () => {
    const reason = classifyFailure(new Error("x".repeat(500)));
    expect(reason.startsWith("run_create_failed: ")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(
      "run_create_failed: ".length + 160,
    );
  });
});
