import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareEvalRun = vi.fn();
const loadSuiteHostConfig = vi.fn();
const resolveEnvironmentForLaunch = vi.fn();

vi.mock("../evals/compat-runtime.js", () => ({
  loadSuiteHostConfig: (...args: unknown[]) => loadSuiteHostConfig(...args),
}));
vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (bearer: string) => ({ bearer }),
}));
vi.mock("../environments/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/resolve.js")>()),
  resolveEnvironmentForLaunch: (...args: unknown[]) =>
    resolveEnvironmentForLaunch(...args),
}));
vi.mock("../xaa-configured-issuer.js", () => ({
  resolveConfiguredXaaIssuer: () => "https://issuer.test/api/web/xaa",
}));

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
  shouldSkipExecution: (prepared: { deduped?: boolean }) => prepared.deduped === true,
}));

import {
  classifyFailure,
  executeClaimedRun,
  startScheduledEvalsWorker,
} from "../scheduled-evals-worker";
import { platformFeeRefusalError } from "../evals/platform-fee-refusal";
import { logger } from "../../utils/logger";
import { serverDrain } from "../lifecycle/drain.js";
import { createAuthorizedManager } from "../../routes/web/auth.js";

const ENTERPRISE_POLICY_HOST = {
  mcpProfile: {
    extensions: { "com.mcpjam/enterprise-managed-auth": { idp: "mcpjam" } },
  },
};

beforeEach(() => {
  // A host with no enterprise policy, unless a test says otherwise.
  loadSuiteHostConfig.mockResolvedValue({});
});

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

  it("acknowledges an adopted active run without executing it again", async () => {
    const execute = vi.fn();
    prepareEvalRun.mockResolvedValueOnce({ runId: "existing-run", suiteId: "suite-1", deduped: true, status: "running", execute });
    await executeClaimedRun(CLAIM);
    expect(execute).not.toHaveBeenCalled();
    expect(completion()).toMatchObject({ triggerId: CLAIM.triggerId, ok: true, runId: "existing-run" });
  });

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

describe("executeClaimedRun connection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      suiteId: "suite-1",
      execute: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    prepareEvalRun.mockReset();
  });

  function connectOptions() {
    expect(createAuthorizedManager).toHaveBeenCalledTimes(1);
    return vi.mocked(createAuthorizedManager).mock.calls[0][7];
  }

  it("keeps plugin placement disabled before an iteration sandbox exists", async () => {
    await executeClaimedRun(CLAIM);
    expect(connectOptions()).toMatchObject({ pluginComputerRuntime: false });
  });

  it("passes the deployment's XAA issuer, having no request to read one from", async () => {
    await executeClaimedRun(CLAIM);

    expect(connectOptions()).toMatchObject({
      xaaIssuer: "https://issuer.test/api/web/xaa",
    });
  });

  it("applies the enterprise policy of the suite's own host", async () => {
    loadSuiteHostConfig.mockResolvedValue(ENTERPRISE_POLICY_HOST);

    await executeClaimedRun(CLAIM);

    // Failing closed: a suite config that cannot be read must stop the run,
    // not fall back to the default host and connect with no policy.
    expect(loadSuiteHostConfig).toHaveBeenCalledWith(
      { bearer: "bearer" },
      "suite-1",
      undefined,
      { failClosed: true },
    );
    expect(connectOptions()).toMatchObject({ xaaPolicy: { idp: "mcpjam" } });
  });

  it("reads the policy from the pinned environment's host", async () => {
    resolveEnvironmentForLaunch.mockResolvedValue({
      environmentRef: { environmentId: "env-1", name: "Prod", revision: 3 },
      hostId: "host-env",
      selectedServerIds: ["srv-1"],
    });
    loadSuiteHostConfig.mockResolvedValue(ENTERPRISE_POLICY_HOST);

    await executeClaimedRun({ ...CLAIM, environmentId: "env-1" });

    expect(loadSuiteHostConfig).toHaveBeenCalledWith(
      { bearer: "bearer" },
      "suite-1",
      "host-env",
      { failClosed: true },
    );
    expect(connectOptions()).toMatchObject({ xaaPolicy: { idp: "mcpjam" } });
  });

  it("stops the run when the host settings cannot be read", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    loadSuiteHostConfig.mockRejectedValue(
      new Error("Couldn't load this suite's host settings"),
    );

    await executeClaimedRun(CLAIM);

    expect(createAuthorizedManager).not.toHaveBeenCalled();
    expect(prepareEvalRun).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toMatchObject({ ok: false });
  });

  it("connects with no policy when the host sets none", async () => {
    await executeClaimedRun(CLAIM);

    expect(connectOptions().xaaPolicy).toBeUndefined();
  });

  it("refuses a host whose policy is invalid before connecting anything", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    loadSuiteHostConfig.mockResolvedValue({
      mcpProfile: {
        extensions: { "com.mcpjam/enterprise-managed-auth": { idp: "okta" } },
      },
    });

    await executeClaimedRun(CLAIM);

    expect(createAuthorizedManager).not.toHaveBeenCalled();
    expect(prepareEvalRun).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toMatchObject({
      ok: false,
      failureReason: expect.stringContaining(
        "unsupported enterprise-managed authorization policy",
      ),
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
    const claim = vi.fn().mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
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

    expect(execute).not.toHaveBeenCalled();
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

  it("stop() during a run ends the loop when the run settles, not after the poll delay", async () => {
    let finishRun!: () => void;
    const claim = vi.fn().mockResolvedValue(CLAIM);
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const handle = startScheduledEvalsWorker({ claim, execute });
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    finishRun();
    // No timer advance: an already-aborted stop must skip the 1 s re-poll wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await stopping;
  });

  it("registers the run it executes with the shutdown drain", async () => {
    let finishRun!: () => void;
    const claim = vi.fn().mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const before = serverDrain.counts().claimed_job ?? 0;
    const handle = startScheduledEvalsWorker({ claim, execute });
    await vi.advanceTimersByTimeAsync(0);
    expect(serverDrain.counts().claimed_job).toBe(before + 1);

    finishRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(serverDrain.counts().claimed_job ?? 0).toBe(before);
    await handle.stop();
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
