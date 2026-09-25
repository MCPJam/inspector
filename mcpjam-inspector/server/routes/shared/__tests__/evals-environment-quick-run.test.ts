/**
 * Environment quick runs through the shared single-case preparation.
 *
 * Pins the inspector half of the contract: a request naming an environment
 * connects the environment's servers as its client, COMMITS every attempt in
 * the backend before any model or tool call, executes the committed rows with
 * the committed model and frozen host config, and fails closed — a refused
 * commit executes nothing, a failure after the commit finalizes the committed
 * rows, and a replayed commit is never executed twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const actionMock = vi.hoisted(() => vi.fn());
const mutationMock = vi.hoisted(() => vi.fn(async () => null));
const streamTestCaseMock = vi.hoisted(() => vi.fn());
const runEvalSuiteMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = vi.fn();
    query = (...args: unknown[]) => queryMock(...args);
    mutation = (...args: unknown[]) => mutationMock(...(args as []));
    action = (...args: unknown[]) => actionMock(...args);
  },
}));

vi.mock("../../../services/evals-runner", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/evals-runner")
  >("../../../services/evals-runner");
  return {
    ...actual,
    streamTestCase: (...args: unknown[]) => streamTestCaseMock(...args),
    runEvalSuiteWithAiSdk: (...args: unknown[]) => runEvalSuiteMock(...args),
  };
});

import {
  runEvalTestCaseWithManager,
  streamEvalTestCaseWithManager,
} from "../evals";
import { WebRouteError } from "../../web/errors";

const RESOLVED = {
  environmentRef: { environmentId: "env-1", name: "Prod", revision: 3 },
  hostId: "host-1",
  hostName: "Claude",
  hostConfigId: "cfg-live",
  effectiveModelId: "openai/gpt-5",
  modelSource: "environment",
  selectedServerIds: ["srv-1"],
  effectiveServerIds: ["srv-1"],
  pluginVersions: [],
  servers: [{ serverId: "srv-1", name: "billing" }],
  serverAttachmentId: "group-1",
};

const FROZEN_HOST_CONFIG = {
  hostStyle: "claude",
  modelId: "openai/gpt-5",
  systemPrompt: "Frozen prompt.",
  temperature: 0.2,
  serverIds: ["srv-1"],
};

const EXECUTION = {
  environmentRef: { environmentId: "env-1", name: "Prod", revision: 3 },
  hostId: "host-1",
  hostConfig: FROZEN_HOST_CONFIG,
  hostConfigId: "cfg-iteration",
  model: "openai/gpt-5",
  provider: "openai",
  modelSource: "environment",
  selectedServerIds: ["srv-1"],
  pluginServerIds: [],
  effectiveServerIds: ["srv-1"],
  pluginVersions: [],
  pinnedSkillCount: 0,
};

const clientManager = {
  listServers: vi.fn(() => ["srv-1"]),
  hasServer: vi.fn((id: string) => id === "srv-1"),
  getToolsForAiSdk: vi.fn(async () => ({})),
};

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    testCaseId: "case-1",
    projectId: "project-1",
    environmentId: "env-1",
    convexAuthToken: "token",
    modelApiKeys: { openai: "sk-test" },
    testCaseOverrides: { query: "Refund the last charge", runs: 2 },
    ...overrides,
  } as Parameters<typeof streamEvalTestCaseWithManager>[1];
}

function commitResponse(overrides: Record<string, unknown> = {}) {
  return {
    iterationIds: ["iter-1", "iter-2"],
    execution: EXECUTION,
    replayed: false,
    ...overrides,
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 64; i++) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
  throw new Error("stream did not finish");
}

function actionCalls(name: string) {
  return actionMock.mock.calls.filter((call) => call[0] === name);
}

describe("environment quick runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    queryMock.mockImplementation(async (name: string) => {
      if (name === "projectEnvironments:resolveEnvironmentForLaunch") {
        return RESOLVED;
      }
      if (name === "testSuites:getTestCase") {
        return {
          _id: "case-1",
          title: "Refund",
          query: "Refund",
          evalTestSuiteId: "suite-1",
          projectId: "project-1",
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        };
      }
      if (name === "hosts:getHost") {
        return { config: { hostStyle: "claude", systemPrompt: "Live." } };
      }
      if (name === "testSuites:getQuickRunPinnedSkills") {
        return { pinnedSkills: [], skillsExcluded: false };
      }
      if (name === "testSuites:resolveQuickRunPluginServersForExecution") {
        return { servers: [], unavailable: [], droppedSnapshotServerIds: [] };
      }
      if (name === "testSuites:getTestIteration") {
        return { _id: "iter-1", status: "completed", result: "passed" };
      }
      if (name === "testSuites:listTestIterations") {
        return [{ _id: "someone-elses-iteration", status: "completed" }];
      }
      return null;
    });
    actionMock.mockImplementation(async (name: string) => {
      if (name === "testSuites:startQuickRunIterations") {
        return commitResponse();
      }
      return null;
    });
    streamTestCaseMock.mockImplementation(async () => [
      { iterationId: "iter-1", evaluation: { passed: true } },
    ]);
    runEvalSuiteMock.mockImplementation(async () => ({
      quickRunIterationOutcomes: [],
    }));
  });

  afterEach(() => {
    delete process.env.CONVEX_URL;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("commits every attempt before execution and runs the committed rows", async () => {
    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      baseRequest(),
    );
    // The commit happened before the stream (and so before any model call).
    const commits = actionCalls("testSuites:startQuickRunIterations");
    expect(commits).toHaveLength(1);
    const commitArgs = commits[0]![1] as Record<string, any>;
    expect(commitArgs).toMatchObject({
      testCaseId: "case-1",
      count: 2,
      environment: {
        environmentId: "env-1",
        expectedRevision: 3,
        expectedHostConfigId: "cfg-live",
        expectedServerIds: ["srv-1"],
      },
    });
    expect(commitArgs.testCaseSnapshot.query).toBe("Refund the last charge");
    expect(typeof commitArgs.idempotencyKey).toBe("string");

    await drain(stream);
    expect(streamTestCaseMock).toHaveBeenCalledOnce();
    const params = streamTestCaseMock.mock.calls[0]![0] as Record<string, any>;
    // The committed rows, model and frozen config — never the live ones.
    expect(params.committedIterationIds).toEqual(["iter-1", "iter-2"]);
    expect(params.test.model).toBe("openai/gpt-5");
    expect(params.test.provider).toBe("openai");
    expect(params.suiteHostConfig).toEqual(FROZEN_HOST_CONFIG);
    expect(params.selectedServers).toEqual(["srv-1"]);
    expect(params.projectEnvironmentId).toBe("env-1");
    // An empty committed skill set stays empty on both channels.
    expect(params.pinnedHarnessSkills).toEqual([]);
    expect(params.pinnedSkillSource).toBeUndefined();
    expect(params.environment.serverBindings).toEqual([
      { serverName: "billing", projectServerId: "srv-1" },
    ]);
  });

  it("answers with the committed row, never the case's latest iteration", async () => {
    const result = await runEvalTestCaseWithManager(
      clientManager as never,
      baseRequest(),
    );
    expect(runEvalSuiteMock).toHaveBeenCalledOnce();
    const params = runEvalSuiteMock.mock.calls[0]![0] as Record<string, any>;
    expect(params.committedQuickRunIterationIds).toEqual(["iter-1", "iter-2"]);
    expect(params.suiteHostConfig).toEqual(FROZEN_HOST_CONFIG);
    expect(params.config.tests[0].model).toBe("openai/gpt-5");
    expect((result.iteration as { _id: string })._id).toBe("iter-1");
    expect(queryMock).not.toHaveBeenCalledWith(
      "testSuites:listTestIterations",
      expect.anything(),
    );
  });

  it("refuses a client configuration override before touching the backend", async () => {
    await expect(
      streamEvalTestCaseWithManager(
        clientManager as never,
        baseRequest({ hostConfigOverride: { hostStyle: "chatgpt" } }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(queryMock).not.toHaveBeenCalled();
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("refuses a model that differs from the environment's", async () => {
    await expect(
      streamEvalTestCaseWithManager(
        clientManager as never,
        baseRequest({ model: "anthropic/claude-sonnet-4" }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "model" },
    });
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("accepts a redundant matching model without forwarding it", async () => {
    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      baseRequest({ model: "openai/gpt-5", provider: "whatever" }),
    );
    await drain(stream);
    const params = streamTestCaseMock.mock.calls[0]![0] as Record<string, any>;
    expect(params.test.provider).toBe("openai");
  });

  it("refuses an environment that pins a sandbox image before any row", async () => {
    queryMock.mockImplementation(async (name: string) =>
      name === "projectEnvironments:resolveEnvironmentForLaunch"
        ? { ...RESOLVED, computerEnvironmentId: "image-1" }
        : null,
    );
    await expect(
      streamEvalTestCaseWithManager(clientManager as never, baseRequest()),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "ENV_QUICK_RUN_UNSUPPORTED" },
    });
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("a refused commit executes nothing", async () => {
    actionMock.mockImplementation(async (name: string) => {
      if (name === "testSuites:startQuickRunIterations") {
        const error = new Error("drift") as Error & { data?: unknown };
        error.data = { code: "ENV_HOST_DRIFT", message: "drifted" };
        throw error;
      }
      return null;
    });
    const failure = await streamEvalTestCaseWithManager(
      clientManager as never,
      baseRequest(),
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(WebRouteError);
    expect(failure.status).toBe(409);
    expect(streamTestCaseMock).not.toHaveBeenCalled();
    expect(actionCalls("testSuites:updateTestIteration")).toHaveLength(0);
  });

  it("fails closed when the backend commits no environment", async () => {
    actionMock.mockImplementation(async (name: string) =>
      name === "testSuites:startQuickRunIterations"
        ? { iterationIds: ["iter-1", "iter-2"] }
        : null,
    );
    await expect(
      streamEvalTestCaseWithManager(clientManager as never, baseRequest()),
    ).rejects.toMatchObject({ status: 502 });
    expect(streamTestCaseMock).not.toHaveBeenCalled();
  });

  it("a setup failure after the commit finalizes every committed row", async () => {
    queryMock.mockImplementation(async (name: string) => {
      if (name === "projectEnvironments:resolveEnvironmentForLaunch") {
        return RESOLVED;
      }
      if (name === "testSuites:getTestCase") {
        return {
          _id: "case-1",
          title: "Refund",
          query: "Refund",
          evalTestSuiteId: "suite-1",
        };
      }
      if (name === "hosts:getHost") return { config: { hostStyle: "claude" } };
      if (name === "testSuites:getQuickRunPinnedSkills") {
        return { pinnedSkills: [] };
      }
      if (name === "testSuites:resolveQuickRunPluginServersForExecution") {
        return {
          servers: [],
          unavailable: [
            {
              pluginVersionId: "pv-1",
              reason: "plugin_disabled",
              pluginName: "acme",
            },
          ],
          droppedSnapshotServerIds: [],
        };
      }
      return null;
    });
    await expect(
      streamEvalTestCaseWithManager(clientManager as never, baseRequest()),
    ).rejects.toThrow(/acme/);
    const failed = actionCalls("testSuites:updateTestIteration").map(
      (call) => call[1] as { iterationId: string; status: string },
    );
    expect(failed.map((row) => row.iterationId).sort()).toEqual([
      "iter-1",
      "iter-2",
    ]);
    expect(failed.every((row) => row.status === "setup_failed")).toBe(true);
    expect(streamTestCaseMock).not.toHaveBeenCalled();
  });

  it("a replayed commit is never executed again", async () => {
    actionMock.mockImplementation(async (name: string) =>
      name === "testSuites:startQuickRunIterations"
        ? commitResponse({ replayed: true })
        : null,
    );
    const stream = await streamEvalTestCaseWithManager(
      clientManager as never,
      baseRequest({ idempotencyKey: "click-123456" }),
    );
    const text = await drain(stream);
    expect(streamTestCaseMock).not.toHaveBeenCalled();
    expect(text).toContain('"type":"complete"');
    expect(text).toContain('"iterationId":"iter-1"');
    expect(
      (
        actionCalls("testSuites:startQuickRunIterations")[0]![1] as {
          idempotencyKey: string;
        }
      ).idempotencyKey,
    ).toBe("click-123456");
  });

  it("a legacy request still needs a model and servers", async () => {
    await expect(
      streamEvalTestCaseWithManager(
        clientManager as never,
        {
          testCaseId: "case-1",
          convexAuthToken: "token",
          serverIds: ["srv-1"],
        } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
