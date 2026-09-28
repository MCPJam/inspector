import { describe, expect, it, vi } from "vitest";
import {
  assertCommittedExecutionMatchesPreflight,
  assertEnvironmentQuickRunAdmissible,
  assertEnvironmentQuickRunModel,
  assertNoConflictingEnvironmentOverrides,
  commitEnvironmentQuickRun,
  failCommittedQuickRun,
  fetchQuickRunPinnedSkills,
  translateQuickRunCommitError,
  type QuickRunExecution,
} from "../quick-run-environment";
import { WebRouteError } from "../../../routes/web/errors";
import type { ResolvedEnvironmentForLaunch } from "../../environments/resolve";

const RESOLVED: ResolvedEnvironmentForLaunch = {
  environmentRef: { environmentId: "env-1", name: "Prod", revision: 3 },
  hostId: "host-1",
  hostConfigId: "cfg-1",
  effectiveModelId: "openai/gpt-5",
  modelSource: "environment",
  selectedServerIds: ["srv-1"],
  effectiveServerIds: ["srv-1", "plugin-srv"],
  servers: [
    { serverId: "srv-1", name: "billing" },
    { serverId: "plugin-srv", name: "acme" },
  ],
};

const EXECUTION: QuickRunExecution = {
  environmentRef: { environmentId: "env-1", name: "Prod", revision: 3 },
  hostId: "host-1",
  hostConfig: { hostStyle: "claude" },
  model: "openai/gpt-5",
  provider: "openai",
  modelSource: "environment",
  selectedServerIds: ["srv-1"],
  pluginServerIds: ["plugin-srv"],
  effectiveServerIds: ["plugin-srv", "srv-1"],
  pluginVersions: [],
  pinnedSkillCount: 0,
};

function convexError(data: Record<string, unknown>) {
  const error = new Error(String(data.message ?? data.code)) as Error & {
    data?: unknown;
  };
  error.data = data;
  return error;
}

describe("assertNoConflictingEnvironmentOverrides", () => {
  it("requires a project", () => {
    expect(() =>
      assertNoConflictingEnvironmentOverrides({ environmentId: "env-1" }),
    ).toThrow(/projectId is required/);
  });

  it("refuses a client configuration override outright", () => {
    expect(() =>
      assertNoConflictingEnvironmentOverrides({
        environmentId: "env-1",
        projectId: "p",
        hostConfigOverride: {},
      }),
    ).toThrow(/hostConfigOverride/);
  });

  it("refuses values that differ from the environment's", () => {
    const base = { environmentId: "env-1", projectId: "p" };
    expect(() =>
      assertNoConflictingEnvironmentOverrides(
        { ...base, model: "anthropic/claude" },
        RESOLVED,
      ),
    ).toThrow(/`model`/);
    expect(() =>
      assertNoConflictingEnvironmentOverrides(
        { ...base, namedHostId: "host-2" },
        RESOLVED,
      ),
    ).toThrow(/`namedHostId`/);
    expect(() =>
      assertNoConflictingEnvironmentOverrides(
        { ...base, serverIds: ["srv-9"] },
        RESOLVED,
      ),
    ).toThrow(/`serverIds`/);
  });

  it("accepts redundant values that match, and an empty server list", () => {
    expect(() =>
      assertNoConflictingEnvironmentOverrides(
        {
          environmentId: "env-1",
          projectId: "p",
          model: "openai/gpt-5",
          namedHostId: "host-1",
          serverIds: ["plugin-srv", "srv-1"],
        },
        RESOLVED,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoConflictingEnvironmentOverrides(
        { environmentId: "env-1", projectId: "p", serverIds: [] },
        RESOLVED,
      ),
    ).not.toThrow();
  });
});

describe("assertEnvironmentQuickRunAdmissible", () => {
  it("refuses a sandbox image with the Start run remedy", () => {
    let error: unknown;
    try {
      assertEnvironmentQuickRunAdmissible({
        ...RESOLVED,
        computerEnvironmentId: "image-1",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebRouteError);
    expect((error as WebRouteError).status).toBe(409);
    expect((error as Error).message).toMatch(/Start run/);
  });

  it("admits an environment without one", () => {
    expect(() => assertEnvironmentQuickRunAdmissible(RESOLVED)).not.toThrow();
  });
});

describe("assertEnvironmentQuickRunModel", () => {
  function refusal(resolved: ResolvedEnvironmentForLaunch): WebRouteError {
    try {
      assertEnvironmentQuickRunModel(resolved);
    } catch (caught) {
      expect(caught).toBeInstanceOf(WebRouteError);
      return caught as WebRouteError;
    }
    throw new Error("expected a refusal");
  }

  it("admits an environment with a model", () => {
    expect(() => assertEnvironmentQuickRunModel(RESOLVED)).not.toThrow();
  });

  it("names the environment and the fix when it has no model", () => {
    const { effectiveModelId: _omitted, ...withoutModel } = RESOLVED;
    for (const resolved of [
      { ...withoutModel, modelSource: "none" as const },
      { ...RESOLVED, effectiveModelId: "" },
      {
        ...RESOLVED,
        // What a JSON `null` looks like after the untyped Convex cast.
        effectiveModelId: null as unknown as string,
        modelSource: undefined,
      },
    ]) {
      const error = refusal(resolved);
      expect(error.status).toBe(409);
      expect(error.message).toBe(
        'Environment "Prod" has no model. Pick a model for this run or set one on the client.',
      );
      expect(error.details).toMatchObject({
        code: "ENV_MODEL_REQUIRED",
        reason: "environment_model_required",
        environmentId: "env-1",
      });
    }
  });

  it("keeps the deploy-skew answer for a backend that reports no model fields", () => {
    const {
      effectiveModelId: _model,
      modelSource: _source,
      ...predatesModelFields
    } = RESOLVED;
    const error = refusal(predatesModelFields);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/cannot run environment quick runs yet/);
    expect(error.details).toMatchObject({
      reason: "ENVIRONMENT_QUICK_RUN_UNAVAILABLE",
    });
  });
});

describe("translateQuickRunCommitError", () => {
  it("maps drift to a retryable 409", () => {
    const mapped = translateQuickRunCommitError(
      convexError({ code: "ENV_HOST_DRIFT", message: "moved" }),
    ) as WebRouteError;
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe("ENVIRONMENT_REVISION_CONFLICT");
  });

  it("keeps an admission refusal's code", () => {
    const mapped = translateQuickRunCommitError(
      convexError({
        code: "ENV_MATERIALIZED_SECRETS_UNSUPPORTED",
        message: "secrets",
      }),
    ) as WebRouteError;
    expect(mapped.status).toBe(409);
    expect(mapped.details).toMatchObject({
      code: "ENV_MATERIALIZED_SECRETS_UNSUPPORTED",
    });
  });

  it("names deploy skew instead of a validator error", () => {
    const mapped = translateQuickRunCommitError(
      new Error(
        "ArgumentValidationError: Object contains extra field `environment`",
      ),
    ) as WebRouteError;
    expect(mapped.status).toBe(400);
    expect(mapped.message).toMatch(/cannot run environment quick runs yet/);
  });

  it("maps a key reused for another request to a 409", () => {
    const mapped = translateQuickRunCommitError(
      convexError({ code: "IDEMPOTENCY_CONFLICT", message: "reused" }),
    ) as WebRouteError;
    expect(mapped.status).toBe(409);
  });
});

describe("commitEnvironmentQuickRun", () => {
  const args = {
    testCaseId: "case-1",
    testCaseSnapshot: { title: "t", query: "q" },
    count: 2,
    startedAt: 1,
    resolved: RESOLVED,
    idempotencyKey: "key-12345678",
  };

  it("echoes the preflight and returns the committed execution", async () => {
    const action = vi.fn(async () => ({
      iterationIds: ["i1", "i2"],
      execution: EXECUTION,
      replayed: false,
    }));
    const committed = await commitEnvironmentQuickRun({ action } as any, args);
    expect(committed.iterationIds).toEqual(["i1", "i2"]);
    expect(committed.replayed).toBe(false);
    expect(action).toHaveBeenCalledWith(
      "testSuites:startQuickRunIterations",
      expect.objectContaining({
        count: 2,
        idempotencyKey: "key-12345678",
        environment: {
          environmentId: "env-1",
          expectedRevision: 3,
          expectedHostConfigId: "cfg-1",
          expectedServerIds: ["srv-1", "plugin-srv"],
        },
      }),
    );
  });

  it("fails closed when fewer rows than attempts come back", async () => {
    const action = vi.fn(async () => ({
      iterationIds: ["i1"],
      execution: EXECUTION,
    }));
    await expect(
      commitEnvironmentQuickRun({ action } as any, args),
    ).rejects.toMatchObject({ status: 502 });
    // The caller never receives these rows, so the commit settles them.
    expect(action).toHaveBeenCalledWith(
      "testSuites:updateTestIteration",
      expect.objectContaining({ iterationId: "i1", status: "setup_failed" }),
    );
  });

  it("settles fresh rows when the execution snapshot is missing", async () => {
    const action = vi.fn(async (name: string) =>
      name === "testSuites:startQuickRunIterations"
        ? { iterationIds: ["i1", "i2"] }
        : null,
    );
    await expect(
      commitEnvironmentQuickRun({ action } as any, args),
    ).rejects.toMatchObject({ status: 502 });
    const settled = action.mock.calls
      .filter(([name]) => name === "testSuites:updateTestIteration")
      .map(
        (call) =>
          (call as unknown as [string, { iterationId: string }])[1].iterationId,
      );
    expect(settled.sort()).toEqual(["i1", "i2"]);
  });

  it("leaves replayed rows to the request that owns them", async () => {
    const action = vi.fn(async (name: string) =>
      name === "testSuites:startQuickRunIterations"
        ? { iterationIds: ["i1", "i2"], replayed: true }
        : null,
    );
    await expect(
      commitEnvironmentQuickRun({ action } as any, args),
    ).rejects.toMatchObject({ status: 502 });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("assertCommittedExecutionMatchesPreflight", () => {
  it("accepts the same environment, client and server set in any order", () => {
    expect(() =>
      assertCommittedExecutionMatchesPreflight(RESOLVED, EXECUTION),
    ).not.toThrow();
  });

  it("refuses anything else", () => {
    expect(() =>
      assertCommittedExecutionMatchesPreflight(RESOLVED, {
        ...EXECUTION,
        effectiveServerIds: ["srv-1"],
      }),
    ).toThrow(/servers/);
    expect(() =>
      assertCommittedExecutionMatchesPreflight(RESOLVED, {
        ...EXECUTION,
        environmentRef: { ...EXECUTION.environmentRef, revision: 4 },
      }),
    ).toThrow(/revision/);
  });
});

describe("fetchQuickRunPinnedSkills", () => {
  it("retries a transient failure and returns the committed pins", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ pinnedSkills: [] });
    await expect(
      fetchQuickRunPinnedSkills({ query }, "i1", async () => {}),
    ).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("never treats a non-environment answer as 'no skills'", async () => {
    const query = vi.fn().mockResolvedValue(null);
    await expect(
      fetchQuickRunPinnedSkills({ query }, "i1", async () => {}),
    ).rejects.toBeInstanceOf(WebRouteError);
  });
});

describe("failCommittedQuickRun", () => {
  it("finalizes every committed row as setup_failed", async () => {
    const action = vi.fn(async () => null);
    await failCommittedQuickRun({ action } as any, ["i1", "i2"], "boom");
    expect(action.mock.calls.map((call) => (call as any)[1])).toEqual([
      expect.objectContaining({ iterationId: "i1", status: "setup_failed" }),
      expect.objectContaining({ iterationId: "i2", status: "setup_failed" }),
    ]);
  });
});
