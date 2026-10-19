/**
 * A durable launch (`services/evals/durable-run.ts`) asks the backend for a
 * worker job with the run, then executes only if THIS replica holds it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = mocks.query;
    mutation = mocks.mutation;
    action = mocks.action;
  },
}));

import { prepareEvalRun, shouldSkipExecution } from "../evals";

const connected = {
  listServers: () => ["s1"],
  hasServer: () => true,
  getConnectionStatus: () => "connected",
  listTools: async () => ({ tools: [] }),
  getAllToolAnnotations: () => ({}),
  hasCachedToolAnnotations: () => true,
  getServerReplayConfigs: () => [],
};

const INPUTS = {
  suiteId: "suite-1",
  projectId: "project-1",
  serverIds: ["s1"],
  source: "api" as const,
};

function launch(overrides: Record<string, unknown> = {}) {
  return prepareEvalRun(
    connected as never,
    {
      suiteId: "suite-1",
      suiteRerun: true,
      serverIds: ["s1"],
      serverNames: ["Linear"],
      tests: [],
      convexAuthToken: "token",
      orgModelConfig: { providers: [] },
      idempotencyKey: "launch-1",
      durable: { launch: INPUTS },
      ...overrides,
    } as never,
  );
}

function claimAnswers(body: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, ...body }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
  mocks.query.mockImplementation(async (name: string) => {
    if (name === "testSuites:listTestCases") return [];
    if (name === "testSuites:resolveRunPluginServersForExecution") {
      return { servers: [], unavailable: [], droppedSnapshotServerIds: [] };
    }
    if (name === "testSuites:getTestSuite") {
      return { projectId: "project-1", environment: { servers: ["s1"] } };
    }
    return null;
  });
  mocks.mutation.mockImplementation(async (name: string) =>
    name === "testSuites:startTestSuiteRun"
      ? { runId: "run-1", testCases: [], deduped: true, status: "running" }
      : null,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("durable eval launch", () => {
  it("asks for a job with the run and stands down when another replica holds it", async () => {
    const fetchMock = claimAnswers({ claimed: false });

    const prepared = await launch();

    expect(mocks.mutation).toHaveBeenCalledWith(
      "testSuites:startTestSuiteRun",
      expect.objectContaining({
        idempotencyKey: "launch-1",
        durableJob: { inputs: JSON.stringify(INPUTS) },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.convex.site/internal/v1/eval-run-jobs/claim",
      expect.objectContaining({
        body: expect.stringContaining('"runId":"run-1"'),
      }),
    );
    expect(prepared.durableHeldElsewhere).toBe(true);
    expect(shouldSkipExecution(prepared)).toBe(true);
  });

  it("asks for a job on a keyless (hosted UI) launch too", async () => {
    claimAnswers({ claimed: false, noJob: true });
    await launch({ idempotencyKey: undefined });
    const start = mocks.mutation.mock.calls.find(
      ([name]) => name === "testSuites:startTestSuiteRun",
    );
    expect(start?.[1]).toMatchObject({
      durableJob: { inputs: JSON.stringify(INPUTS) },
    });
    expect(start?.[1]).not.toHaveProperty("idempotencyKey");
  });

  it("runs a launch the backend kept process-owned", async () => {
    claimAnswers({ claimed: false, noJob: true });
    const prepared = await launch();
    expect(prepared.durableHeldElsewhere).toBeUndefined();
  });

  it("never makes a launch carrying request-only model keys durable", async () => {
    const fetchMock = claimAnswers({ claimed: false });
    await launch({ modelApiKeys: { openai: "sk-request-only" } }).catch(
      () => undefined,
    );
    const start = mocks.mutation.mock.calls.find(
      ([name]) => name === "testSuites:startTestSuiteRun",
    );
    expect(start?.[1]).not.toHaveProperty("durableJob");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
