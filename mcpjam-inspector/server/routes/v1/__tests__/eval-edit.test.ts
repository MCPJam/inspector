import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpaqueId } from "@mcpjam/sdk/contract";
import { MAX_CASES_PER_BATCH } from "../../shared/eval-case-batch.js";
import { Hono } from "hono";

// Covers the v1 eval-edit surface: suite settings/schedule/delete + case CRUD
// + generate. Asserts public→internal translation, DTO scrubbing (no internal
// columns leak), project-scope guards, null-clears, schedule preserve-interval,
// environment edits without a live MCP connection, and generate persistence.

const {
  validateGuestTokenMock,
  createAuthorizedManagerMock,
  generateEvalTestsMock,
  generateNegativeEvalTestsMock,
  convexQueryMock,
  convexMutationMock,
  convexActionMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  generateEvalTestsMock: vi.fn(),
  generateNegativeEvalTestsMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  convexActionMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js"
  );
  return {
    ...actual,
    generateEvalTestsWithManager: generateEvalTestsMock,
    generateNegativeEvalTestsWithManager: generateNegativeEvalTestsMock,
  };
});

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js"
  );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: convexActionMock,
  })),
}));

import { deriveItemIdempotencyKey } from "../../../utils/idempotency.js";
import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token = "tok"
): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const SUITE_DOC = {
  _id: "suite_1",
  projectId: "p1",
  createdBy: "user_1",
  workspaceId: "ws_1",
  name: "My Suite",
  description: "desc",
  environment: {
    servers: ["Excalidraw (App)"],
    serverBindings: [
      { serverName: "Excalidraw (App)", projectServerId: "srv_1" },
    ],
  },
  defaultPassCriteria: { minimumPassRate: 80 },
  defaultMatchOptions: {
    toolCallOrder: "superset",
    maxExtraToolCalls: null,
    argumentMatching: "exact",
  },
  defaultPredicates: [{ type: "responseContains", needle: "hi" }],
  judgeConfig: {
    goalCompletion: { enabled: true, judgeModel: "openai/gpt-5-mini" },
  },
  schedule: { enabled: false, intervalMinutes: 60 },
  createdAt: 1,
  updatedAt: 2,
};

const EXEC_CONFIG = {
  id: "hc_1",
  schemaVersion: 2,
  hostStyle: "default",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "be helpful",
  temperature: 0.5,
  requireToolApproval: false,
  serverIds: ["srv_1"],
  optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 30000 },
  clientCapabilities: {},
  hostContext: {},
};

const CASE_DOC = {
  _id: "case_1",
  testSuiteId: "suite_1",
  projectId: "p1",
  createdBy: "user_1",
  workspaceId: "ws_1",
  caseKey: "ui_abc",
  title: "Lists tools",
  query: "What tools?",
  runs: 1,
  models: [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
  expectedToolCalls: [{ toolName: "list", arguments: {} }],
  expectedOutput: "a list",
  isNegativeTest: false,
  promptTurns: [],
  matchOptions: {
    toolCallOrder: "ignore",
    maxExtraToolCalls: null,
    argumentMatching: "partial",
  },
  predicates: {
    mode: "replace",
    list: [{ type: "responseContains", needle: "x" }],
  },
  caseType: "prompt",
  createdAt: 1,
  updatedAt: 2,
};

function defaultQueryImpl(name: string) {
  if (name === "testSuites:getTestSuite") return Promise.resolve(SUITE_DOC);
  if (name === "hostConfigsV2:getSuiteConfig")
    return Promise.resolve(EXEC_CONFIG);
  if (name === "testSuites:listTestCases") return Promise.resolve([CASE_DOC]);
  if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
  if (name === "hosts:listHosts") return Promise.resolve([]);
  return Promise.resolve(null);
}

/**
 * Stand in for `testSuites:createTestCases`, committing every item.
 *
 * Shaped like the real mutation's reply rather than a bare id: the routes read
 * `caseUpsert.committed[i].testCaseId` and the effective `caseId`, so a mock
 * that returned only an id would let a route that ignores the batch envelope
 * keep passing.
 */
function batchCreateResult(args: {
  cases?: Array<Record<string, unknown>>;
  duplicatePolicy?: unknown;
}) {
  const cases = args?.cases ?? [];
  return {
    caseUpsert: {
      committed: cases.map((item, index) => ({
        index,
        title: String(item.title ?? ""),
        testCaseId: `case_${index + 1}`,
        ...(item.caseId ? { caseId: String(item.caseId) } : {}),
        replayed: false,
      })),
      failed: [],
    },
    duplicatePolicy: {
      ...(args?.duplicatePolicy !== undefined
        ? { requestedPolicy: String(args.duplicatePolicy) }
        : {}),
      effectivePolicy: "block",
      coerced: false,
    },
    warnings: [],
  };
}

/**
 * The args of one case authored through `testSuites:createTestCases`.
 *
 * Every first-party create — the single-case route included — now goes through
 * the batch mutation, so the per-case payload lives at `cases[i]` rather than
 * being the whole mutation argument.
 */
function authoredCaseArgs(index = 0): any {
  const call = convexMutationMock.mock.calls.find(
    (c) => c[0] === "testSuites:createTestCases"
  );
  return call?.[1]?.cases?.[index];
}

/** The args of the most recent `testSuites:updateTestCase` call. */
function updateArgs(): any {
  const calls = convexMutationMock.mock.calls.filter(
    (c) => c[0] === "testSuites:updateTestCase"
  );
  return calls[calls.length - 1]?.[1];
}

/** Every case authored across all batch calls, in order. */
function allAuthoredCaseArgs(): any[] {
  return convexMutationMock.mock.calls
    .filter((c) => c[0] === "testSuites:createTestCases")
    .flatMap((c) => c[1]?.cases ?? []);
}

function defaultMutationImpl(name: string, args?: any) {
  if (name === "testSuites:createTestCases")
    return Promise.resolve(batchCreateResult(args));
  if (name === "testSuites:createTestCase") return Promise.resolve("case_1");
  if (name === "testSuites:updateTestCase") return Promise.resolve(CASE_DOC);
  if (name === "testSuites:updateTestSuite") return Promise.resolve(SUITE_DOC);
  return Promise.resolve(null);
}

describe("v1 eval-edit routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) =>
      defaultQueryImpl(name)
    );
    convexMutationMock.mockImplementation((name: string, args?: any) =>
      defaultMutationImpl(name, args)
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("GET suite returns a scrubbed public DTO (no internal columns)", async () => {
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("suite_1");
    expect(body._id).toBeUndefined();
    expect(body.createdBy).toBeUndefined();
    expect(body.workspaceId).toBeUndefined();
    expect(body.settings.minimumAccuracy).toBe(80);
    // internal "superset" surfaces as public "in-order".
    expect(body.settings.matchOptions.toolCallOrder).toBe("in-order");
    expect(body.settings.matchOptions.arguments).toBe("exact");
    // Fully resolved: the suite's own `enabled`/`judgeModel` where set, the
    // platform defaults (GOAL_COMPLETION_DEFAULTS) for the rest.
    expect(body.settings.judge).toEqual({
      enabled: true,
      model: "openai/gpt-5-mini",
      autoRun: false,
      threshold: 0.7,
    });
    expect(body.executionConfig).toEqual({
      model: "anthropic/claude-haiku-4.5",
      systemPrompt: "be helpful",
      temperature: 0.5,
    });
    expect(body.environment.servers).toEqual(["Excalidraw (App)"]);
  });

  it("GET suite from another project is 404", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, projectId: "p2" })
        : defaultQueryImpl(name)
    );
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    expect(res.status).toBe(404);
  });

  it("PATCH suite maps public settings to internal updateTestSuite args", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        name: "Renamed",
        settings: {
          minimumAccuracy: 75,
          matchOptions: {
            toolCallOrder: "exact",
            extraToolCalls: 3,
            arguments: "ignore",
          },
          judge: { enabled: false },
        },
      }
    );
    expect(res.status).toBe(200);
    const call = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    );
    expect(call).toBeTruthy();
    const args = call![1];
    expect(args.name).toBe("Renamed");
    expect(args.defaultPassCriteria).toEqual({ minimumPassRate: 75 });
    expect(args.defaultMatchOptions).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: 3,
      argumentMatching: "ignore",
    });
    // Merge preserves the suite's existing judgeModel while flipping enabled.
    expect(args.judgeConfig).toEqual({
      goalCompletion: { enabled: false, judgeModel: "openai/gpt-5-mini" },
    });
  });

  it("PATCH minimumIterations sets the floor, and null clears it", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { minimumIterations: 3 } }
    );
    expect(res.status).toBe(200);
    expect(
      convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestSuite"
      )![1].minIterations
    ).toBe(3);

    vi.clearAllMocks();
    convexQueryMock.mockImplementation((name: string) =>
      defaultQueryImpl(name)
    );
    convexMutationMock.mockImplementation((name: string) =>
      defaultMutationImpl(name)
    );

    // `null` must arrive as null, not collapse to undefined — the platform
    // reads undefined as "leave alone", so a dropped null is a clear that
    // reports success and changes nothing.
    const cleared = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { minimumIterations: null } }
    );
    expect(cleared.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args).toHaveProperty("minIterations");
    expect(args.minIterations).toBeNull();
  });

  it("PATCH rejects a minimumIterations outside 1–10", async () => {
    for (const value of [0, 11, 2.5]) {
      vi.clearAllMocks();
      convexQueryMock.mockImplementation((name: string) =>
        defaultQueryImpl(name)
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        { settings: { minimumIterations: value } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    }
  });

  it("GET reports minimumIterations, null when the suite has no floor", async () => {
    const unset = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1"
    );
    expect(((await unset.json()) as any).settings.minimumIterations).toBeNull();

    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, minIterations: 4 })
        : defaultQueryImpl(name)
    );
    const set = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    expect(((await set.json()) as any).settings.minimumIterations).toBe(4);
  });

  it("PATCH round-trips judge autoRun and threshold", async () => {
    // `autoRun` is the flag the grader gates on — a suite can be `enabled`
    // forever and never grade a run without it, which is exactly the gap the
    // API had while it accepted only `enabled` + `model`.
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { judge: { autoRun: true, threshold: 0.85 } } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args.judgeConfig).toEqual({
      goalCompletion: {
        enabled: true,
        judgeModel: "openai/gpt-5-mini",
        autoRun: true,
        threshold: 0.85,
      },
    });
  });

  it("PATCH judge.model alone preserves an already-set autoRun", async () => {
    // The merge reads the suite's CURRENT goalCompletion, so a caller editing
    // one judge field cannot silently switch grading back off.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            judgeConfig: {
              goalCompletion: {
                enabled: true,
                judgeModel: "openai/gpt-5-mini",
                autoRun: true,
                threshold: 0.9,
              },
            },
          })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { judge: { model: "openai/gpt-5" } } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args.judgeConfig).toEqual({
      goalCompletion: {
        enabled: true,
        judgeModel: "openai/gpt-5",
        autoRun: true,
        threshold: 0.9,
      },
    });
  });

  it("GET reports resolved judge defaults for a suite with no judgeConfig", async () => {
    // A suite that never touched the judge reports what a run WOULD grade
    // with, not a half-resolved `enabled: true` beside `model: null` — a
    // combination that never exists at run time.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, judgeConfig: undefined })
        : defaultQueryImpl(name)
    );
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.judge).toEqual({
      enabled: true,
      model: "openai/gpt-5.4-mini",
      autoRun: false,
      threshold: 0.7,
    });
  });

  it("PATCH partial settings merge onto current values (no field reset)", async () => {
    // Only judge.model and only matchOptions.arguments — everything else must
    // be preserved from the suite's current settings.
    const resJudge = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { judge: { model: "openai/gpt-5" } } }
    );
    expect(resJudge.status).toBe(200);
    const judgeArgs = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    // enabled (true) preserved from current; only judgeModel changed.
    expect(judgeArgs.judgeConfig).toEqual({
      goalCompletion: { enabled: true, judgeModel: "openai/gpt-5" },
    });

    vi.clearAllMocks();
    convexQueryMock.mockImplementation((name: string) =>
      defaultQueryImpl(name)
    );
    convexMutationMock.mockImplementation((name: string) =>
      defaultMutationImpl(name)
    );

    const resMatch = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { settings: { matchOptions: { arguments: "partial" } } }
    );
    expect(resMatch.status).toBe(200);
    const matchArgs = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    // toolCallOrder (superset) + maxExtraToolCalls (null) preserved.
    expect(matchArgs.defaultMatchOptions).toEqual({
      toolCallOrder: "superset",
      maxExtraToolCalls: null,
      argumentMatching: "partial",
    });
  });

  it("PATCH suite environment uses bindings, never a live connection", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        environment: { servers: ["Excalidraw (App)"] },
      }
    );
    expect(res.status).toBe(200);
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    // The platform REPLACES the environment envelope wholesale, so a partial
    // write must be layered onto the suite's current one. Sending `{ servers }`
    // alone dropped the bindings the rest of this test is about.
    expect(args.environment).toEqual({
      servers: ["Excalidraw (App)"],
      serverBindings: [
        { serverName: "Excalidraw (App)", projectServerId: "srv_1" },
      ],
    });
    expect(args.refreshHostConfigFromEnvironment).toBe(true);
  });

  it("PATCH computerEnvironment resolves by name and preserves servers + bindings", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "computerEnvironments:listEnvironments") {
        return Promise.resolve([
          { environmentId: "img_1", projectId: "p1", name: "Playwright" },
          { environmentId: "img_2", projectId: "p1", name: "Node 22" },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { environment: { computerEnvironment: "playwright" } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args.environment).toEqual({
      servers: ["Excalidraw (App)"],
      serverBindings: [
        { serverName: "Excalidraw (App)", projectServerId: "srv_1" },
      ],
      computerEnvironmentId: "img_1",
    });
    // Pinning an image does not change which servers a host sees, so the host
    // config does not need rebuilding.
    expect(args.refreshHostConfigFromEnvironment).toBeUndefined();
  });

  it("PATCH computerEnvironment null clears the pin", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            environment: {
              ...SUITE_DOC.environment,
              computerEnvironmentId: "img_1",
            },
          })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { environment: { computerEnvironment: null } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args.environment.computerEnvironmentId).toBeUndefined();
    expect(args.environment.servers).toEqual(["Excalidraw (App)"]);
  });

  it("PATCH servers alone carries an existing computer-image pin through", async () => {
    // The regression this whole merge exists to prevent: editing the server
    // list used to silently unpin the suite's image.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            environment: {
              ...SUITE_DOC.environment,
              computerEnvironmentId: "img_1",
            },
          })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { environment: { servers: ["Excalidraw (App)", "Other"] } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite"
    )![1];
    expect(args.environment.computerEnvironmentId).toBe("img_1");
    expect(args.environment.servers).toEqual(["Excalidraw (App)", "Other"]);
  });

  it("PATCH an unknown computer image 404s and names the real choices", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "computerEnvironments:listEnvironments") {
        return Promise.resolve([
          { environmentId: "img_1", projectId: "p1", name: "Playwright" },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { environment: { computerEnvironment: "ghost" } }
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.message).toContain("ghost");
    expect(body.message).toContain("Playwright (id: img_1)");
    // Resolution happens BEFORE the write, so nothing is persisted.
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("PATCH an ambiguous computer image name is a 400", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "computerEnvironments:listEnvironments") {
        return Promise.resolve([
          { environmentId: "img_1", projectId: "p1", name: "Playwright" },
          { environmentId: "img_2", projectId: "p1", name: "playwright" },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      { environment: { computerEnvironment: "Playwright" } }
    );
    expect(res.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("GET reports the pinned computer image with its resolved name", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") {
        return Promise.resolve({
          ...SUITE_DOC,
          environment: {
            ...SUITE_DOC.environment,
            computerEnvironmentId: "img_1",
          },
        });
      }
      if (name === "computerEnvironments:getEnvironment") {
        return Promise.resolve({
          environmentId: "img_1",
          projectId: "p1",
          name: "Playwright",
        });
      }
      return defaultQueryImpl(name);
    });
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.environment.computerEnvironment).toEqual({
      id: "img_1",
      name: "Playwright",
    });
  });

  it("GET reports an unpinned suite's computer image as null", async () => {
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    const body = (await res.json()) as any;
    expect(body.environment.computerEnvironment).toBeNull();
  });

  it("PATCH env+hosts resolves host server picks against the patched environment", async () => {
    // First getTestSuite read has only the old binding; after the environment
    // update, the re-read exposes the newly-added server's binding.
    let suiteReads = 0;
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") {
        suiteReads += 1;
        return Promise.resolve(
          suiteReads === 1
            ? SUITE_DOC
            : {
                ...SUITE_DOC,
                environment: {
                  servers: ["New Server"],
                  serverBindings: [
                    { serverName: "New Server", projectServerId: "srv_new" },
                  ],
                },
              }
        );
      }
      if (name === "hosts:listHosts")
        return Promise.resolve([{ hostId: "host_1", name: "Prod" }]);
      return defaultQueryImpl(name);
    });

    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        environment: { servers: ["New Server"] },
        hosts: [{ host: "Prod", servers: ["New Server"] }],
      }
    );
    expect(res.status).toBe(200);
    const hostCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite" && c[1].hostAttachments
    );
    expect(hostCall![1].hostAttachments).toEqual([
      { namedHostId: "host_1", selectedServerIds: ["srv_new"] },
    ]);
    // The suite was re-read (twice) so the new server's binding was visible.
    expect(suiteReads).toBeGreaterThanOrEqual(2);
  });

  it("PATCH hosts.servers resolves a projectServerId as well as a bound name", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "hosts:listHosts")
        return Promise.resolve([{ hostId: "host_1", name: "Prod" }]);
      return defaultQueryImpl(name);
    });

    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        hosts: [{ host: "host_1", servers: ["srv_1"] }],
      }
    );
    expect(res.status).toBe(200);
    const hostCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite" && c[1].hostAttachments
    );
    expect(hostCall![1].hostAttachments).toEqual([
      { namedHostId: "host_1", selectedServerIds: ["srv_1"] },
    ]);
  });

  it("PATCH suite rejects the hostIds/servers near-miss (400, names the keys)", async () => {
    // The reported silent no-op: undeclared top-level keys used to 200 with
    // hosts: [] and zero mutations. Strict body + path-aware errors name them.
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        hostIds: ["host_1"],
        servers: ["Excalidraw (App)"],
      }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("hostIds");
    expect(body.message).toContain("servers");
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("PATCH execution config round-trips getSuiteConfig and preserves servers", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1",
      {
        executionConfig: { temperature: 0.9 },
      }
    );
    expect(res.status).toBe(200);
    const call = convexMutationMock.mock.calls.find(
      (c) => c[0] === "hostConfigsV2:setSuiteConfig"
    );
    expect(call).toBeTruthy();
    const input = call![1].input;
    expect(input.temperature).toBe(0.9);
    // unspecified fields preserved from the current config
    expect(input.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(input.serverIds).toEqual(["srv_1"]);
    expect(input.connectionDefaults).toBeTruthy();
  });

  it("schedule disable preserves the stored interval", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/schedule",
      { enabled: false }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:setSuiteSchedule"
    )![1];
    expect(args.enabled).toBe(false);
    const body = (await res.json()) as any;
    expect(body.schedule).toEqual({
      enabled: false,
      intervalMinutes: 60,
      // Project-environment schedule pin (read-only DTO field); this suite
      // has none.
      environmentId: null,
    });
  });

  it("re-enabling without interval reuses the suite's saved interval", async () => {
    // SUITE_DOC.schedule.intervalMinutes === 60 (e.g. after a disable).
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/schedule",
      { enabled: true }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:setSuiteSchedule"
    )![1];
    // No interval forwarded — the backend reuses the saved one.
    expect(args).toEqual({ suiteId: "suite_1", enabled: true });
  });

  describe("project-environment attachments", () => {
    const ENV_SUITE = { ...SUITE_DOC, environmentIds: ["env_1", "env_2"] };
    const ENVIRONMENT_ROWS = [
      { environmentId: "env_1", name: "Staging" },
      { environmentId: "env_2", name: "Prod" },
    ];

    /** An env-based suite whose environments can be listed for error messages. */
    function mockEnvSuite(environmentIds: string[]): void {
      convexQueryMock.mockImplementation((name: string) => {
        if (name === "testSuites:getTestSuite")
          return Promise.resolve({ ...SUITE_DOC, environmentIds });
        if (name === "projectEnvironments:listEnvironments")
          return Promise.resolve(ENVIRONMENT_ROWS);
        return defaultQueryImpl(name);
      });
    }

    it("pins the schedule to a named attached environment", async () => {
      mockEnvSuite(["env_1", "env_2"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: true, intervalMinutes: 60, environmentId: "env_2" }
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteSchedule"
      )![1];
      expect(args).toEqual({
        suiteId: "suite_1",
        enabled: true,
        intervalMinutes: 60,
        environmentId: "env_2",
      });
    });

    it("defaults the schedule pin on a single-environment suite", async () => {
      mockEnvSuite(["env_1"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: true }
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteSchedule"
      )![1];
      expect(args.environmentId).toBe("env_1");
    });

    it("400s an unpinned enable on a multi-environment suite, naming both", async () => {
      mockEnvSuite(["env_1", "env_2"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: true }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        message?: string;
        details?: { reason?: string };
      };
      expect(body.details?.reason).toBe("ENVIRONMENT_REQUIRED");
      expect(body.message).toContain("Staging");
      expect(body.message).toContain("Prod");
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteSchedule"
        )
      ).toBe(false);
    });

    it("400s an environment that the suite has not attached", async () => {
      mockEnvSuite(["env_1"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: true, environmentId: "env_ghost" }
      );
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason
      ).toBe("ENVIRONMENT_NOT_ATTACHED");
    });

    it("400s an environment sent with a disable rather than dropping it", async () => {
      mockEnvSuite(["env_1"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: false, environmentId: "env_1" }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toContain(
        "only applies when enabling"
      );
    });

    it("PATCH suite forwards environmentIds to setSuiteEnvironments", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          environmentIds: ["env_1", "env_2"],
        }
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments"
      )![1];
      expect(args).toEqual({
        suiteId: "suite_1",
        environmentIds: ["env_1", "env_2"],
      });
    });

    it("PATCH suite clears attachments with an explicit null", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          environmentIds: null,
        }
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments"
      )![1];
      expect(args.environmentIds).toBeNull();
    });

    it("PATCH suite rejects [] instead of treating it as a clear", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          environmentIds: [],
        }
      );
      expect(res.status).toBe(400);
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteEnvironments"
        )
      ).toBe(false);
    });

    it("PATCH rejects a stranding environment change before applying the legacy edits", async () => {
      // Enabled schedule pinned to env_2, which the change drops.
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              environmentIds: ["env_1", "env_2"],
              schedule: {
                enabled: true,
                intervalMinutes: 60,
                environmentId: "env_2",
              },
            })
          : defaultQueryImpl(name)
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          name: "Renamed",
          environmentIds: ["env_1"],
        }
      );

      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason
      ).toBe("SCHEDULE_ENVIRONMENT_PINNED");
      // The whole PATCH is a no-op: the rename must NOT have landed just
      // because it happened to be applied before the environment write.
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("PATCH rejects converting to multi-environment under an unpinned enabled schedule", async () => {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              schedule: { enabled: true, intervalMinutes: 60 },
            })
          : defaultQueryImpl(name)
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          environmentIds: ["env_1", "env_2"],
        }
      );

      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason
      ).toBe("SCHEDULE_ENVIRONMENT_PIN_REQUIRED");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("PATCH allows dropping a pinned environment when the schedule is disabled", async () => {
      // A disabled schedule's dangling pin is not an error — the mutation
      // strips it in the same transaction.
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              environmentIds: ["env_1", "env_2"],
              schedule: {
                enabled: false,
                intervalMinutes: 60,
                environmentId: "env_2",
              },
            })
          : defaultQueryImpl(name)
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          environmentIds: ["env_1"],
        }
      );

      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments"
      )![1];
      expect(args.environmentIds).toEqual(["env_1"]);
    });

    it("PATCH suite leaves attachments alone when the field is omitted", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        {
          name: "Renamed",
        }
      );
      expect(res.status).toBe(200);
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteEnvironments"
        )
      ).toBe(false);
    });

    it("GET suite exposes the schedule's environment pin", async () => {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...ENV_SUITE,
              schedule: {
                enabled: true,
                intervalMinutes: 60,
                environmentId: "env_2",
              },
            })
          : defaultQueryImpl(name)
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/eval-suites/suite_1"
      );
      const body = (await res.json()) as any;
      expect(body.environmentIds).toEqual(["env_1", "env_2"]);
      expect(body.schedule.environmentId).toBe("env_2");
    });
  });

  it("enabling without interval AND no saved interval is a 400", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, schedule: undefined })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/schedule",
      { enabled: true }
    );
    expect(res.status).toBe(400);
  });

  it("GET reads explicit null maxExtraToolCalls as unlimited, not the legacy flag", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            // Modern field present (null = unlimited) alongside a stale legacy
            // boolean — the modern field must win.
            defaultMatchOptions: {
              toolCallOrder: "ignore",
              maxExtraToolCalls: null,
              allowExtraToolCalls: false,
              argumentMatching: "partial",
            },
          })
        : defaultQueryImpl(name)
    );
    const res = await request("GET", "/api/v1/projects/p1/eval-suites/suite_1");
    const body = (await res.json()) as any;
    expect(body.settings.matchOptions.extraToolCalls).toBe("unlimited");
  });

  it("PATCH case merges partial match options onto the existing override", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { matchOptions: { arguments: "exact" } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    // CASE_DOC.matchOptions toolCallOrder/maxExtraToolCalls preserved.
    expect(args.matchOptions).toEqual({
      toolCallOrder: "ignore",
      maxExtraToolCalls: null,
      argumentMatching: "exact",
    });
  });

  it("PATCH prompt-case steps never forward caseType", async () => {
    // CASE_DOC.caseType === "prompt"; patching with prompt steps keeps the kind
    // and must not forward caseType to updateTestCase (which rejects it).
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { steps: [{ id: "s1", kind: "prompt", prompt: "updated" }] }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    expect(args.caseType).toBeUndefined();
    expect(args.steps).toEqual([
      { id: "s1", kind: "prompt", prompt: "updated" },
    ]);
    expect(args.query).toBe("updated");
  });

  it("PATCH case rejects a kind change with 400", async () => {
    // The kind is derived from `steps`: a single model-free `toolCall` step is
    // a render-check. Patching a prompt case with render-check steps is a kind
    // change and must be rejected.
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      {
        steps: [
          {
            id: "s1",
            kind: "toolCall",
            serverName: "s",
            toolName: "t",
            arguments: {},
          },
        ],
      }
    );
    expect(res.status).toBe(400);
  });

  it("PATCH render-check maps a single toolCall step to steps only", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestCase"
        ? Promise.resolve({
            ...CASE_DOC,
            caseType: "widget_probe",
            query: "",
            probeConfig: {
              serverName: "Excalidraw (App)",
              toolName: "old",
              arguments: { keep: 1 },
              renderTimeoutMs: 5000,
            },
          })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      {
        steps: [
          {
            id: "s1",
            kind: "toolCall",
            serverName: "Excalidraw (App)",
            toolName: "new_tool",
            arguments: { keep: 1 },
            renderTimeoutMs: 5000,
          },
        ],
      }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    expect(args.probeConfig).toBeUndefined();
    expect(args.caseType).toBeUndefined();
    expect(args.steps).toEqual([
      {
        id: "s1",
        kind: "toolCall",
        serverName: "Excalidraw (App)",
        toolName: "new_tool",
        arguments: { keep: 1 },
        renderTimeoutMs: 5000,
      },
      {
        id: "s1-rendered",
        kind: "assert",
        assertion: { type: "widgetRendered", toolName: "new_tool" },
      },
    ]);
    expect(args.query).toBe("");
  });

  it("GET projects a single-turn case onto a prompt + toolCalledWith assert step", async () => {
    // A persisted single-turn prompt case carries one top-level query +
    // expectedToolCalls; the DTO projects it onto a `prompt` step followed by
    // a `toolCalledWith` assert step.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestCase"
        ? Promise.resolve({
            ...CASE_DOC,
            query: "only turn",
            expectedToolCalls: [{ toolName: "list", arguments: {} }],
            promptTurns: [],
          })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
    );
    const body = (await res.json()) as any;
    expect(body.steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "only turn",
    });
    expect(body.steps[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list" },
    });
    expect(body.kind).toBeUndefined();
    expect(body.turns).toBeUndefined();
  });

  it("DELETE suite returns a minimal acknowledgement", async () => {
    const res = await request(
      "DELETE",
      "/api/v1/projects/p1/eval-suites/suite_1"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "suite_1", deleted: true });
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:deleteTestSuite"
      )
    ).toBe(true);
  });

  it("create case without models derives the provider for a bare suite default", async () => {
    // Suite execution config stores a BARE model id (no slash).
    convexQueryMock.mockImplementation((name: string) =>
      name === "hostConfigsV2:getSuiteConfig"
        ? Promise.resolve({ ...EXEC_CONFIG, modelId: "claude-sonnet-4-5" })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "bare",
        steps: [
          { id: "s1", kind: "prompt", prompt: "hi" },
          {
            id: "s2",
            kind: "assert",
            assertion: {
              type: "toolCalledWith",
              toolName: "x",
              args: { args: {} },
            },
          },
        ],
      }
    );
    expect(res.status).toBe(201);
    const args = authoredCaseArgs();
    // Provider resolved via the catalog, not dropped to [].
    expect(args.models).toEqual([
      { model: "claude-sonnet-4-5", provider: "anthropic" },
    ]);
    expect(args.steps).toEqual([
      { id: "s1", kind: "prompt", prompt: "hi" },
      {
        id: "s2",
        kind: "assert",
        assertion: {
          type: "toolCalledWith",
          toolName: "x",
          args: { args: {} },
        },
      },
    ]);
  });

  it.each([
    ["cohere/command-a", "cohere"],
    ["nvidia/nemotron-3-nano-30b-a3b", "nvidia"],
  ])(
    "attributes %s to its real vendor, not the Ollama catch-all",
    async (model, provider) => {
      // These vendors are in the hosted CATALOG but not in the classifier's
      // prefix map. Consulting the catalog only for bare ids answered them
      // from the map's `ollama` catch-all — which then short-circuits
      // `assertInlineTestModelsValid` (ollama is an open namespace), so a
      // typo'd hosted id stopped being caught here and was dispatched at a
      // local Ollama instead.
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        {
          title: "vendor",
          steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
          models: [{ model }],
        }
      );
      expect(res.status).toBe(201);
      const args = authoredCaseArgs();
      expect(args.models).toEqual([{ model, provider }]);
    }
  );

  it("falls back to the vendor PREFIX for a qualified id nothing knows", async () => {
    // Not in the catalog and not in the prefix map. `ollama` is the
    // classifier's answer for a BARE id; for a qualified one the vendor the
    // author wrote is strictly better information than a guess.
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "unknown vendor",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        // No explicit `provider`: `deriveProvider` returns an explicit one
        // verbatim, so passing it would satisfy the assertion without ever
        // reaching the fallback under test.
        models: [{ model: "newvendor/some-model" }],
      }
    );
    expect(res.status).toBe(201);
    const args = authoredCaseArgs();
    expect(args.models).toEqual([
      { model: "newvendor/some-model", provider: "newvendor" },
    ]);
  });

  it("leaves the case model-less when the suite default cannot be attributed", async () => {
    // A bare id no catalog knows (an org BYOK id). Pinning a provider is a
    // durable write and `ollama` would be a guess; "no default" is not a
    // failure but the case inheriting the suite model at run time, where the
    // runner can see keys this route cannot.
    convexQueryMock.mockImplementation((name: string) =>
      name === "hostConfigsV2:getSuiteConfig"
        ? Promise.resolve({ ...EXEC_CONFIG, modelId: "org-private-model" })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "inherits",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      }
    );
    expect(res.status).toBe(201);
    const args = authoredCaseArgs();
    expect(args.models).toEqual([]);
  });

  it("TRIMS a padded model id rather than persisting it verbatim", async () => {
    // The id is stored and handed to the provider verbatim, so a padded value
    // would resolve to the right provider and then match nothing downstream.
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "padded",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        models: [{ model: "  openai/gpt-5  " }],
      }
    );
    expect(res.status).toBe(201);
    const args = authoredCaseArgs();
    expect(args.models).toEqual([
      { model: "openai/gpt-5", provider: "openai" },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    // Whitespace-only WITHOUT a provider already had nowhere to go. WITH one,
    // `deriveProvider` returns early and never inspects the model — so this is
    // the case that used to persist `{ model: "", provider: "openai" }`: a case
    // that passes validation and then has no model to run.
    [
      "whitespace-only, with an explicit provider",
      { model: "   ", provider: "openai" },
    ],
    ["whitespace-only, without a provider", { model: "   " }],
    // These two never reached the route helper — `z.string().min(1)` rejects
    // them at the schema. Pinned anyway so the endpoint's contract is one
    // statement ("no usable id is a 400") rather than a fact about which of two
    // layers happens to catch each shape.
    ["literally empty", { model: "" }],
    ["null", { model: null }],
    ["null, with an explicit provider", { model: null, provider: "openai" }],
  ])("REJECTS a model id that carries no value — %s", async (_label, entry) => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "blank",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        models: [entry],
      }
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases"
      )
    ).toBe(false);
  });

  it("GET cases returns scrubbed public case DTOs", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1/cases"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const item = body.items[0];
    expect(item.id).toBe("case_1");
    expect(item._id).toBeUndefined();
    expect(item.testSuiteId).toBeUndefined();
    expect(item.kind).toBeUndefined();
    expect(item.steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "What tools?",
    });
    expect(item.steps[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list" },
    });
    expect(item.iterations).toBe(1);
    expect(item.matchOptions.toolCallOrder).toBe("any");
  });

  it("PATCH case clears match options when passed null", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { matchOptions: null, checks: null }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    expect(args.matchOptions).toBeNull();
    expect(args.predicates).toBeNull();
  });

  it("PATCH case sets, preserves and clears intent by the three wire states", async () => {
    // The whole contract, on the surface a UI and the CLI both write through.
    // Getting it wrong is not cosmetic: a silent clear re-attributes a case's
    // history to "Unlabeled", and a silent preserve makes a retag invisible.
    const argsOf = () =>
      convexMutationMock.mock.calls.findLast(
        (c: unknown[]) => c[0] === "testSuites:updateTestCase"
      )![1] as Record<string, unknown>;

    const set = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { intent: "search" }
    );
    expect(set.status).toBe(200);
    expect(argsOf().intent).toBe("search");

    const cleared = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { intent: null }
    );
    expect(cleared.status).toBe(200);
    expect(argsOf().intent).toBeNull();

    // Omitted: the mutation must not be told anything about intent at all.
    // Passing `undefined` through would be the same bug spelled differently —
    // Convex reads a present-but-undefined key as a clear.
    const untouched = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      { title: "renamed" }
    );
    expect(untouched.status).toBe(200);
    expect("intent" in argsOf()).toBe(false);
  });

  it("POST case drops a null intent rather than sending it to create", async () => {
    // On create there is no stored label to clear, and the create mutation does
    // not accept null — the same asymmetry `matchOptions` has.
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "new case",
        steps: [{ id: "s1", kind: "prompt", prompt: "go" }],
        intent: null,
      }
    );
    expect([200, 201]).toContain(res.status);
    const created = convexMutationMock.mock.calls.findLast((c: unknown[]) =>
      String(c[0]).includes("createTestCase")
    );
    if (created) expect("intent" in (created[1] as object)).toBe(false);
  });

  it("PATCH on a render-check case stays a render-check via toolCall steps", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestCase")
        return Promise.resolve({
          ...CASE_DOC,
          caseType: "widget_probe",
          query: "",
          probeConfig: {
            serverName: "Excalidraw (App)",
            toolName: "old",
            arguments: {},
          },
        });
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
      {
        steps: [
          {
            id: "s1",
            kind: "toolCall",
            serverName: "Excalidraw (App)",
            toolName: "new_tool",
            arguments: {},
          },
        ],
      }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    // The toolCall step keeps the case a render-check (kind unchanged).
    expect(args.probeConfig).toBeUndefined();
    expect(args.caseType).toBeUndefined();
    expect(args.steps[0]).toMatchObject({
      kind: "toolCall",
      toolName: "new_tool",
    });
    expect(args.query).toBe("");
  });

  it("DELETE case returns a minimal acknowledgement", async () => {
    const res = await request(
      "DELETE",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "case_1", deleted: true });
  });

  it("generate persists drafts and reports the generation model", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [
        {
          title: "Generated A",
          query: "do a thing",
          runs: 1,
          expectedToolCalls: [{ toolName: "list", arguments: {} }],
        },
      ],
    });
    // Suite has a saved selection so generate resolves servers without override.
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({
          serverIds: ["srv_1"],
          serverNames: ["Excalidraw (App)"],
        });
      return defaultQueryImpl(name);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "normal" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.generationModel).toBe("anthropic/claude-haiku-4.5");
    expect(body.created).toHaveLength(1);
    expect(body.counts.normal).toBe(1);
    expect(generateEvalTestsMock).toHaveBeenCalled();
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases"
      )
    ).toBe(true);
    const createArgs = authoredCaseArgs();
    expect(createArgs.steps).toHaveLength(2);
    expect(createArgs.steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "do a thing",
    });
    expect(createArgs.steps[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list" },
    });
    expect(createArgs.promptTurns).toBeUndefined();
  });

  it("generate carries the backend's sanitized arguments through verbatim", async () => {
    // Producer-side regression for the assertions that could never pass. The
    // backend now drops every expected-argument entry the case's own prompt
    // does not determine, so what arrives here is already narrow. This pins
    // that the inspector neither re-inflates it nor drops what survived: the
    // step's args are EXACTLY the backend's, and an empty object stays empty
    // (under `partial` matching that reads as "this tool was called", which is
    // the assertion a correct server can satisfy).
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [
        {
          title: "Draw a rectangle",
          query: "Draw a rectangle on the canvas",
          runs: 1,
          expectedToolCalls: [
            { toolName: "create_element", arguments: { type: "rectangle" } },
          ],
        },
        {
          title: "Draw a flowchart",
          query: "Draw a flowchart of our deploy process",
          runs: 1,
          expectedToolCalls: [{ toolName: "create_element", arguments: {} }],
        },
      ],
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      return defaultQueryImpl(name);
    });

    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "normal" }
    );
    expect(res.status).toBe(200);

    const assertions = allAuthoredCaseArgs()
      .flatMap((item: any) => item.steps ?? [])
      .filter((step: any) => step.kind === "assert")
      .map((step: any) => step.assertion);
    expect(assertions).toEqual([
      {
        type: "toolCalledWith",
        toolName: "create_element",
        args: { args: { type: "rectangle" } },
      },
      {
        type: "toolCalledWith",
        toolName: "create_element",
        args: { args: {} },
      },
    ]);
    // No unmatched free-form payload anywhere: every asserted argument value
    // is a scalar. A nested object or array here is the shape that made the
    // 2026-08-20 Excalidraw cases unpassable.
    for (const assertion of assertions) {
      for (const value of Object.values(assertion.args.args)) {
        expect(typeof value).not.toBe("object");
      }
    }
  });

  it("generate discovers tools from the suite's environment, not its saved selection", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite")
        return Promise.resolve({ ...SUITE_DOC, environmentIds: ["env_1"] });
      if (name === "projectEnvironments:resolveEnvironmentForLaunch")
        return Promise.resolve({
          environmentRef: {
            environmentId: "env_1",
            name: "Staging",
            revision: 3,
          },
          hostId: "host_1",
          selectedServerIds: ["srv_env"],
          servers: [{ serverId: "srv_env_live", name: "env server" }],
        });
      return defaultQueryImpl(name);
    });

    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {}
    );

    expect(res.status).toBe(200);
    // The environment's closed set is connected; the legacy rollback selection
    // is never read — cases generated against it would describe tools the
    // suite's runs never see.
    expect(createAuthorizedManagerMock.mock.calls[0][3]).toEqual([
      "srv_env_live",
    ]);
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      "testSuites:getSuiteRunServerSelection",
      expect.anything()
    );
  });

  it("generate rejects a server override on an environment-based suite", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite")
        return Promise.resolve({ ...SUITE_DOC, environmentIds: ["env_1"] });
      if (name === "projectEnvironments:listEnvironments")
        return Promise.resolve([{ environmentId: "env_1", name: "Staging" }]);
      return defaultQueryImpl(name);
    });

    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { servers: ["srv_1"] }
    );

    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { details?: { reason?: string } }).details?.reason
    ).toBe("ENVIRONMENT_SERVERS_NOT_OVERRIDABLE");
    // No connection, no tool discovery, no credit spent.
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
  });

  it("generate rejects environmentId together with servers at the schema", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { environmentId: "env_1", servers: ["srv_1"] }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message).toContain(
      "mutually exclusive"
    );
  });

  it("generate with an idempotency key records the ledger before persisting and keys each case", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [
        { title: "A", query: "one", runs: 1, expectedToolCalls: [] },
        { title: "B", query: "two", runs: 1, expectedToolCalls: [] },
      ],
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      // No prior ledger for this key.
      if (name === "testSuites:getCaseGeneration") return Promise.resolve(null);
      return defaultQueryImpl(name);
    });

    const res = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          "x-mcpjam-idempotency-key": "proposal:act_1:generate_eval_cases",
        },
        body: JSON.stringify({ mode: "normal" }),
      }
    );
    expect(res.status).toBe(200);

    // The ledger write must precede the first case persist: it is the
    // checkpoint that makes a crash after this point replayable WITHOUT a
    // second LLM spend.
    const calls = convexMutationMock.mock.calls.map((c) => c[0]);
    const ledgerIndex = calls.indexOf("testSuites:recordCaseGeneration");
    const firstCaseIndex = calls.indexOf("testSuites:createTestCases");
    expect(ledgerIndex).toBeGreaterThanOrEqual(0);
    expect(firstCaseIndex).toBeGreaterThan(ledgerIndex);

    // Every case carries the EXACT derived per-item key — positional under
    // the caller's key — so a resumed persistence loop lands on the first
    // attempt's rows. Asserting the literal derivation (not just "some
    // string") is the point: a fresh-per-attempt or operation-independent key
    // would still be a non-empty string and would still duplicate cases.
    // One BATCH now carries both cases, so the per-item keys are read off the
    // items rather than off two separate mutation calls. The derivation is
    // unchanged: the caller still derives them, positionally, per draft.
    const caseItems = allAuthoredCaseArgs();
    expect(caseItems).toHaveLength(2);
    const keys = caseItems.map((item: any) => item.idempotencyKey);
    expect(keys).toEqual([
      deriveItemIdempotencyKey("proposal:act_1:generate_eval_cases", "0"),
      deriveItemIdempotencyKey("proposal:act_1:generate_eval_cases", "1"),
    ]);
  });

  it("generate checkpoints an EMPTY result and fails closed on an unreadable ledger", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      if (name === "testSuites:getCaseGeneration") return Promise.resolve(null);
      return defaultQueryImpl(name);
    });

    // "The generator ran and produced nothing" is a spend too — without the
    // checkpoint every keyed retry would pay for it again.
    const res = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          "x-mcpjam-idempotency-key": "proposal:act_2:generate_eval_cases",
        },
        body: JSON.stringify({ mode: "normal" }),
      }
    );
    expect(res.status).toBe(200);
    const ledgerCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:recordCaseGeneration"
    );
    expect(ledgerCall?.[1].drafts).toEqual([]);

    // And a keyed request whose ledger cannot be READ must 503 (retryable),
    // never silently regenerate: a backend blip is exactly when the first
    // attempt's spend is most likely to be invisible.
    generateEvalTestsMock.mockClear();
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      if (name === "testSuites:getCaseGeneration")
        return Promise.reject(new Error("convex down"));
      return defaultQueryImpl(name);
    });
    const blocked = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          "x-mcpjam-idempotency-key": "proposal:act_2:generate_eval_cases",
        },
        body: JSON.stringify({ mode: "normal" }),
      }
    );
    // 502 SERVER_UNREACHABLE — the repo's retryable upstream-failure status.
    expect(blocked.status).toBe(502);
    expect(generateEvalTestsMock).not.toHaveBeenCalled();
  });

  it("generate replays recorded drafts on a keyed retry instead of re-spending", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      if (name === "testSuites:getCaseGeneration")
        return Promise.resolve({
          drafts: [
            {
              title: "Cached",
              query: "from ledger",
              runs: 1,
              expectedToolCalls: [],
            },
          ],
          createdCaseIds: null,
        });
      return defaultQueryImpl(name);
    });

    const res = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          "x-mcpjam-idempotency-key": "proposal:act_1:generate_eval_cases",
        },
        body: JSON.stringify({ mode: "normal" }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.created).toHaveLength(1);
    // The whole point: no MCP connection, no generator call, no second spend.
    expect(generateEvalTestsMock).not.toHaveBeenCalled();
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    // And no duplicate ledger write for the replay.
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:recordCaseGeneration"
      )
    ).toBe(false);
  });

  /**
   * The gap these close: before this, the generate route read ONLY the
   * `x-mcpjam-idempotency-key` header, while `PlatformApiClient` sends
   * `idempotency-key` and the operation had no body field at all. So the CLI,
   * the MCP plugin, and direct SDK callers — exactly the surfaces that hit the
   * 30s client timeout and retry — had no way to reach the ledger, and every
   * retry re-spent. The failure was SILENT: a key went out on the wire and
   * nothing read it.
   *
   * Each test therefore asserts against the ledger read (`getCaseGeneration`
   * carries the key) and not merely that a key was sent.
   */
  function ledgerKeys(): unknown[] {
    return convexQueryMock.mock.calls
      .filter((c) => c[0] === "testSuites:getCaseGeneration")
      .map((c) => (c[1] as any)?.idempotencyKey);
  }

  function withNoPriorLedger() {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      if (name === "testSuites:getCaseGeneration") return Promise.resolve(null);
      return defaultQueryImpl(name);
    });
  }

  async function generateWith(init: {
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }) {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    withNoPriorLedger();
    return makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          ...(init.headers ?? {}),
        },
        body: JSON.stringify({ mode: "normal", ...(init.body ?? {}) }),
      }
    );
  }

  it("generate reaches the ledger with a BODY idempotency key", async () => {
    const res = await generateWith({ body: { idempotencyKey: "cli-run-7" } });
    expect(res.status).toBe(200);
    expect(ledgerKeys()).toContain("cli-run-7");
    expect(
      convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:recordCaseGeneration"
      )?.[1].idempotencyKey
    ).toBe("cli-run-7");
  });

  it("generate reaches the ledger with the SDK client's transport header", async () => {
    // `PlatformApiClient` puts `options.idempotencyKey` here, unprefixed.
    // Reading only the prefixed spelling is what made a key sent this way
    // degrade silently to no idempotency at all.
    const res = await generateWith({
      headers: { "idempotency-key": "sdk-transport-key" },
    });
    expect(res.status).toBe(200);
    expect(ledgerKeys()).toContain("sdk-transport-key");
  });

  it("generate lets the prefixed HEADER win over both other channels", async () => {
    // The agent adapter sets the prefixed header per operation; a body key
    // could otherwise be shaped by model output, so it must never override it.
    const res = await generateWith({
      headers: {
        "x-mcpjam-idempotency-key": "proposal:act_9:generate_eval_cases",
        "idempotency-key": "sdk-transport-key",
      },
      body: { idempotencyKey: "body-key" },
    });
    expect(res.status).toBe(200);
    expect(ledgerKeys()).toEqual(["proposal:act_9:generate_eval_cases"]);
  });

  it("generate prefers the transport header over a body key", async () => {
    const res = await generateWith({
      headers: { "idempotency-key": "sdk-transport-key" },
      body: { idempotencyKey: "body-key" },
    });
    expect(res.status).toBe(200);
    expect(ledgerKeys()).toEqual(["sdk-transport-key"]);
  });

  it("generate stays keyless — and reads no ledger — when no key is sent", async () => {
    // The unkeyed path must keep working exactly as before: no ledger read,
    // no ledger write, and certainly no fabricated key.
    const res = await generateWith({});
    expect(res.status).toBe(200);
    expect(ledgerKeys()).toEqual([]);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:recordCaseGeneration"
      )
    ).toBe(false);
  });

  it("generate replays the first attempt's drafts for a BODY key retry", async () => {
    // The end-to-end property the plumbing exists for: retrying with the same
    // key from a direct caller costs nothing and returns the same cases.
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      if (name === "testSuites:getCaseGeneration")
        return Promise.resolve({
          drafts: [
            {
              title: "Cached",
              query: "from ledger",
              runs: 1,
              expectedToolCalls: [],
            },
          ],
          createdCaseIds: null,
        });
      return defaultQueryImpl(name);
    });

    const res = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
        },
        body: JSON.stringify({ mode: "normal", idempotencyKey: "cli-run-7" }),
      }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).created).toHaveLength(1);
    expect(generateEvalTestsMock).not.toHaveBeenCalled();
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
  });

  it("generate resolves a server NAME override to an ID before authorizing", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    convexQueryMock.mockImplementation((name: string) =>
      name === "servers:getProjectServers"
        ? Promise.resolve([{ _id: "srv_1", name: "Excalidraw (App)" }])
        : defaultQueryImpl(name)
    );
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "normal", servers: ["Excalidraw (App)"] }
    );
    expect(res.status).toBe(200);
    // createAuthorizedManager receives the resolved ID, not the name.
    const managerArgs = createAuthorizedManagerMock.mock.calls[0];
    expect(managerArgs[3]).toEqual(["srv_1"]);
  });

  it("generate surfaces drafts that failed to persist under `skipped`", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [
        { title: "Bad draft", query: "x", runs: 1, expectedToolCalls: [] },
      ],
    });
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getSuiteRunServerSelection"
        ? Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] })
        : defaultQueryImpl(name)
    );
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.reject(new Error("Server Error\nUncaught Error: nope"));
      return defaultMutationImpl(name, args);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "normal" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.created).toHaveLength(0);
    expect(body.skipped).toEqual([
      { title: "Bad draft", error: expect.any(String) },
    ]);
  });

  it("generate forwards caseMix + varyUserStyles as generationOptions", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({
          serverIds: ["srv_1"],
          serverNames: ["Excalidraw (App)"],
        });
      return defaultQueryImpl(name);
    });

    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      {
        caseMix: { simple: 3, negative: 1 },
        varyUserStyles: true,
      }
    );
    expect(res.status).toBe(200);
    const forwarded = generateEvalTestsMock.mock.calls.at(-1)?.[1];
    expect(forwarded?.generationOptions).toEqual({
      caseMix: { simple: 3, negative: 1 },
      varyUserStyles: true,
    });
  });

  it("generate omits generationOptions when no knobs are provided", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({
          serverIds: ["srv_1"],
          serverNames: ["Excalidraw (App)"],
        });
      return defaultQueryImpl(name);
    });

    await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "normal" }
    );
    const forwarded = generateEvalTestsMock.mock.calls.at(-1)?.[1];
    expect(forwarded?.generationOptions).toBeUndefined();
  });

  it("caseMix supersedes mode:negative — uses the plan-driven generator and forwards generationOptions", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
    generateNegativeEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [],
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({
          serverIds: ["srv_1"],
          serverNames: ["Excalidraw (App)"],
        });
      return defaultQueryImpl(name);
    });

    await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "negative", caseMix: { negative: 4 } }
    );
    // Routed to the plan-driven generator, NOT the legacy negative-only one.
    expect(generateNegativeEvalTestsMock).not.toHaveBeenCalled();
    const forwarded = generateEvalTestsMock.mock.calls.at(-1)?.[1];
    expect(forwarded?.generationOptions).toEqual({
      caseMix: { negative: 4 },
    });
  });

  it.each([
    { label: "empty {}", caseMix: {} },
    { label: "zero-sum { negative: 0 }", caseMix: { negative: 0 } },
    {
      label: "all-zero buckets",
      caseMix: {
        simple: 0,
        multiTool: 0,
        multiTurn: 0,
        complex: 0,
        negative: 0,
      },
    },
  ])(
    "treats a bucketless caseMix ($label) as absent — mode:negative still uses the negative-only generator",
    async ({ caseMix }) => {
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
      });
      generateEvalTestsMock.mockResolvedValue({ success: true, tests: [] });
      generateNegativeEvalTestsMock.mockResolvedValue({
        success: true,
        tests: [],
      });
      convexQueryMock.mockImplementation((name: string) => {
        if (name === "testSuites:getSuiteRunServerSelection")
          return Promise.resolve({
            serverIds: ["srv_1"],
            serverNames: ["Excalidraw (App)"],
          });
        return defaultQueryImpl(name);
      });

      await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
        { mode: "negative", caseMix }
      );
      // A caseMix with no bucket > 0 must not supersede mode: the negative-only
      // generator is used, and no empty generationOptions leaks downstream.
      expect(generateNegativeEvalTestsMock).toHaveBeenCalled();
      expect(generateEvalTestsMock).not.toHaveBeenCalled();
      const forwarded = generateNegativeEvalTestsMock.mock.calls.at(-1)?.[1];
      expect(forwarded?.generationOptions).toBeUndefined();
    }
  );

  it("mode:negative + caseMix persists per-draft negativity (positives keep tool calls)", async () => {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    // The plan-driven generator flags each draft; the request still carries
    // mode:"negative", which must NOT force the positive draft negative.
    generateEvalTestsMock.mockResolvedValue({
      success: true,
      tests: [
        {
          title: "Pos",
          query: "do a thing",
          runs: 1,
          expectedToolCalls: [{ toolName: "list", arguments: {} }],
          isNegativeTest: false,
        },
        {
          title: "Neg",
          query: "meta question",
          runs: 1,
          expectedToolCalls: [],
          isNegativeTest: true,
        },
      ],
    });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({
          serverIds: ["srv_1"],
          serverNames: ["Excalidraw (App)"],
        });
      return defaultQueryImpl(name);
    });

    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
      { mode: "negative", caseMix: { simple: 1, negative: 1 } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.counts).toEqual({ normal: 1, negative: 1 });

    const createArgs = allAuthoredCaseArgs();
    const posArgs = createArgs.find((a: any) => a.title === "Pos");
    const negArgs = createArgs.find((a: any) => a.title === "Neg");
    // Positive draft keeps its tool calls and is NOT marked negative.
    expect(posArgs.isNegativeTest).toBeUndefined();
    expect(posArgs.expectedToolCalls).toEqual([
      { toolName: "list", arguments: {} },
    ]);
    expect(posArgs.steps).toHaveLength(2);
    expect(posArgs.steps[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "list" },
    });
    // Negative draft is marked negative with no tool calls.
    expect(negArgs.isNegativeTest).toBe(true);
    expect(negArgs.expectedToolCalls).toEqual([]);
    expect(negArgs.steps).toEqual([
      expect.objectContaining({ kind: "prompt", prompt: "meta question" }),
    ]);
  });

  // ── Wave-0 declared identity + the batch authoring surface ───────────────

  it("mints a declared id for a create that does not carry one", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        title: "no id",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      }
    );
    expect(res.status).toBe(201);
    // This first-party surface mints rather than leaving the case identity-less.
    expect(isOpaqueId(authoredCaseArgs().caseId)).toBe(true);
  });

  it("forwards a caller-supplied id as the declared case id, unchanged", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        id: "c_from_suite_file",
        title: "declared",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      }
    );
    expect(res.status).toBe(201);
    const args = authoredCaseArgs();
    expect(args.caseId).toBe("c_from_suite_file");
    // A declared identity is never written into the storage key (D7).
    expect(args.caseKey).toBeUndefined();
  });

  it("rejects an id outside the opaque-id charset at the boundary", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        id: "not a valid id",
        title: "bad id",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      }
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases"
      )
    ).toBe(false);
  });

  it("reports a duplicate declared id as 409, not as a created case", async () => {
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: [],
            failed: [
              {
                index: 0,
                title: "dupe",
                caseId: "c_taken",
                code: "DUPLICATE_CASE_ID",
                message: 'Case id "c_taken" is already used in this suite.',
              },
            ],
          },
          duplicatePolicy: { effectivePolicy: "block", coerced: false },
          warnings: [],
        });
      return defaultMutationImpl(name, args);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      {
        id: "c_taken",
        title: "dupe",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.details.reason).toBe("DUPLICATE_CASE_ID");
  });

  it("reports a semantic per-item failure as 400", async () => {
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: [],
            failed: [
              {
                index: 0,
                title: "bad",
                code: "INVALID_CASE",
                message:
                  "Positive test cases must include at least one assertion",
              },
            ],
          },
          duplicatePolicy: { effectivePolicy: "block", coerced: false },
          warnings: [],
        });
      return defaultMutationImpl(name, args);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases",
      { title: "bad", steps: [{ id: "s1", kind: "prompt", prompt: "hi" }] }
    );
    expect(res.status).toBe(400);
  });

  it("GET exposes the declared id alongside the platform id", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestCase"
        ? Promise.resolve({ ...CASE_DOC, declaredCaseId: "c_readback" })
        : defaultQueryImpl(name)
    );
    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
    );
    const body = (await res.json()) as any;
    // Two DIFFERENT identities: the row id addresses the case in a URL, the
    // declared id is what the author committed to a suite file.
    expect(body.id).toBe("case_1");
    expect(body.declaredId).toBe("c_readback");
  });

  it("omits declaredId for a case authored before declared identity existed", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
    );
    const body = (await res.json()) as any;
    expect(body).not.toHaveProperty("declaredId");
  });

  it("POST /cases/batch authors every case in ONE mutation", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          {
            id: "c_b",
            title: "b",
            steps: [{ id: "s1", kind: "prompt", prompt: "b" }],
          },
        ],
      }
    );
    expect(res.status).toBe(201);
    const batchCalls = convexMutationMock.mock.calls.filter(
      (c) => c[0] === "testSuites:createTestCases"
    );
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0][1].cases).toHaveLength(2);
    // Missing ids are minted; supplied ones are kept.
    expect(isOpaqueId(batchCalls[0][1].cases[0].caseId)).toBe(true);
    expect(batchCalls[0][1].cases[1].caseId).toBe("c_b");

    const body = (await res.json()) as any;
    expect(body.created).toEqual([
      {
        index: 0,
        id: "case_1",
        declaredId: expect.any(String),
        title: "a",
        replayed: false,
      },
      {
        index: 1,
        id: "case_2",
        declaredId: "c_b",
        title: "b",
        replayed: false,
      },
    ]);
    expect(body.failed).toEqual([]);
    expect(body.duplicatePolicy).toEqual({
      effectivePolicy: "block",
      coerced: false,
    });
  });

  it("POST /cases/batch reports a refused case WITHOUT rolling back its siblings", async () => {
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: [
              {
                index: 0,
                title: "a",
                testCaseId: "case_1",
                caseId: "c_a",
                replayed: false,
              },
            ],
            failed: [
              {
                index: 1,
                title: "b",
                code: "DUPLICATE_CONTENT",
                message: "This case has the same definition as case_9.",
              },
            ],
          },
          duplicatePolicy: { effectivePolicy: "block", coerced: false },
          warnings: [],
        });
      return defaultMutationImpl(name, args);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          { title: "b", steps: [{ id: "s1", kind: "prompt", prompt: "b" }] },
        ],
      }
    );
    // 201, not 4xx: case "a" really was written, and a 4xx would tell the
    // caller to retry a write that already landed.
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.created).toHaveLength(1);
    expect(body.failed).toEqual([
      {
        index: 1,
        title: "b",
        code: "DUPLICATE_CONTENT",
        message: "This case has the same definition as case_9.",
      },
    ]);
  });

  it("POST /cases/batch reports a policy coercion rather than applying it silently", async () => {
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: { committed: [], failed: [] },
          duplicatePolicy: {
            requestedPolicy: "blcok",
            effectivePolicy: "block",
            coerced: true,
          },
          warnings: [
            {
              code: "DUPLICATE_POLICY_COERCED",
              message: 'Unrecognized duplicatePolicy "blcok"; applied "block".',
            },
          ],
        });
      return defaultMutationImpl(name, args);
    });
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
        duplicatePolicy: "blcok",
      }
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.duplicatePolicy).toEqual({
      requestedPolicy: "blcok",
      effectivePolicy: "block",
      coerced: true,
    });
    expect(body.warnings).toHaveLength(1);
  });

  it("POST /cases/batch forwards the duplicate policy and its override reason", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
        duplicatePolicy: "create_anyway",
        overrideReason: "porting a fixture verbatim",
      }
    );
    expect(res.status).toBe(201);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:createTestCases"
    )![1];
    expect(args.duplicatePolicy).toBe("create_anyway");
    expect(args.overrideReason).toBe("porting a fixture verbatim");
  });

  it("POST /cases/batch keys each case by its declared id, else by position", async () => {
    const res = await makeApp().request(
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          "x-mcpjam-idempotency-key": "turn_1",
        },
        body: JSON.stringify({
          cases: [
            { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
            {
              id: "c_b",
              title: "b",
              steps: [{ id: "s1", kind: "prompt", prompt: "b" }],
            },
          ],
        }),
      }
    );
    expect(res.status).toBe(201);
    const items = allAuthoredCaseArgs();
    // Both carry a key — an interrupted import lands on its original rows on
    // retry rather than authoring the suite twice.
    expect(items[0].idempotencyKey).toEqual(expect.any(String));
    expect(items[1].idempotencyKey).toEqual(expect.any(String));
    expect(items[0].idempotencyKey).not.toBe(items[1].idempotencyKey);
  });

  it("POST /cases/batch sends no idempotency key when the caller supplied none", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
      }
    );
    expect(res.status).toBe(201);
    expect(allAuthoredCaseArgs()[0].idempotencyKey).toBeUndefined();
  });

  it("POST /cases/batch refuses more than the cap in one call", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: Array.from({ length: MAX_CASES_PER_BATCH + 1 }, (_, i) => ({
          title: `case-${i}`,
          steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        })),
      }
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases"
      )
    ).toBe(false);
  });

  it("POST /cases/batch refuses an empty cases array", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      { cases: [] }
    );
    expect(res.status).toBe(400);
  });

  it("POST /cases/batch names the offending entry when one has no steps", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
      {
        cases: [
          { title: "ok", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          { title: "no steps" },
        ],
      }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("cases[1]");
    // Nothing is authored: a batch with an unusable entry is a mistake about
    // the whole request, caught before the first write.
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases"
      )
    ).toBe(false);
  });

  /**
   * The per-case IMPORT CLAIM, across every public write and read.
   *
   * Asserted at the TRANSPORT boundary — the exact Convex mutation argument and
   * the exact response body — rather than by "the request succeeded". `import`
   * is built key-by-key out of a strict schema on the way in and picked
   * field-by-field on the way out, so a route that dropped it would still 201
   * and still look right; the only thing that catches it is reading what
   * actually crossed each edge.
   */
  describe("per-case import claim", () => {
    const PROMPT_STEP = { id: "s1", kind: "prompt", prompt: "hi" };
    const CLAIM = {
      status: "exact",
      sourceCaseKey: "upstream/refunds/duplicate-charge",
      note: "1:1 with the upstream single-turn assertion form.",
    };

    it("forwards the claim on a single create", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        { title: "t", steps: [PROMPT_STEP], import: CLAIM }
      );
      expect(res.status).toBe(201);
      expect(authoredCaseArgs().import).toEqual(CLAIM);
    });

    it("forwards each case's own claim on a batch create", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
        {
          cases: [
            { title: "a", steps: [PROMPT_STEP], import: CLAIM },
            {
              title: "b",
              steps: [PROMPT_STEP],
              import: { status: "approximated", note: "Mapped to negative." },
            },
            // Native: no block at all. The batch must not manufacture one.
            { title: "c", steps: [PROMPT_STEP] },
          ],
        }
      );
      expect(res.status).toBe(201);
      const authored = allAuthoredCaseArgs();
      expect(authored[0].import).toEqual(CLAIM);
      expect(authored[1].import).toEqual({
        status: "approximated",
        note: "Mapped to negative.",
      });
      expect("import" in authored[2]).toBe(false);
    });

    it("forwards a claim on PATCH, and `null` to remove one", async () => {
      const set = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        { import: CLAIM }
      );
      expect(set.status).toBe(200);
      expect(updateArgs().import).toEqual(CLAIM);

      convexMutationMock.mockClear();
      const cleared = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        { import: null }
      );
      expect(cleared.status).toBe(200);
      // `null` is the REMOVE instruction, and it has to survive as null: a
      // route that coerced it to undefined would report success while leaving
      // the stale claim on the row.
      expect(updateArgs().import).toBeNull();
    });

    it("leaves the claim alone when PATCH omits it", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        { title: "Renamed" }
      );
      expect(res.status).toBe(200);
      // Omitted ≠ null. Sending `import: null` here would silently strip the
      // provenance off every case anyone renames.
      expect("import" in updateArgs()).toBe(false);
    });

    it("projects the stored claim back on a case read", async () => {
      convexQueryMock.mockImplementation((name: string) => {
        if (name === "testSuites:getTestCase")
          return Promise.resolve({ ...CASE_DOC, import: CLAIM });
        return defaultQueryImpl(name);
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { import?: unknown };
      expect(body.import).toEqual(CLAIM);
    });

    it("omits `import` entirely for a natively authored case", async () => {
      const res = await request(
        "GET",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
      );
      expect(res.status).toBe(200);
      // Absent, not `null` and not an empty object: "authored here" and
      // "imported, claim unknown" are different facts about a case.
      expect("import" in ((await res.json()) as object)).toBe(false);
    });

    it("never publishes the acceptance bookkeeping stored beside the claim", async () => {
      convexQueryMock.mockImplementation((name: string) => {
        if (name === "testSuites:getTestCase")
          return Promise.resolve({
            ...CASE_DOC,
            import: {
              ...CLAIM,
              acceptedBy: "user_9",
              acceptedAt: 1756100000000,
              acceptanceReason: "internal",
              acceptedSourceHash: "deadbeef",
            },
          });
        return defaultQueryImpl(name);
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
      );
      const body = (await res.json()) as { import?: Record<string, unknown> };
      // The stored row is a superset of the public claim. Spreading it would
      // publish internal columns the contract never promised and cannot
      // un-publish once a client depends on them.
      expect(body.import).toEqual(CLAIM);
    });

    it("reports an unreadable stored status as no claim at all", async () => {
      convexQueryMock.mockImplementation((name: string) => {
        if (name === "testSuites:getTestCase")
          return Promise.resolve({
            ...CASE_DOC,
            import: { status: "definitely-not-a-status", note: "?" },
          });
        return defaultQueryImpl(name);
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1"
      );
      expect(res.status).toBe(200);
      expect("import" in ((await res.json()) as object)).toBe(false);
    });

    it.each([
      [
        "an approval actor",
        { status: "approximated", note: "ok", approvedBy: "user_9" },
        "approvedBy",
      ],
      [
        "an approval time",
        { status: "approximated", note: "ok", approvedAt: 1756100000000 },
        "approvedAt",
      ],
      [
        "a frozen run decision",
        {
          status: "approximated",
          note: "ok",
          importRunDecision: { status: "approved_approximation" },
        },
        "importRunDecision",
      ],
      [
        "an accepted-at column",
        { status: "approximated", note: "ok", acceptedAt: 1 },
        "acceptedAt",
      ],
    ] as const)(
      "refuses %s smuggled into a create's claim (400, no mutation)",
      async (_label, claim, key) => {
        const res = await request(
          "POST",
          "/api/v1/projects/p1/eval-suites/suite_1/cases",
          { title: "t", steps: [PROMPT_STEP], import: claim }
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { code?: string; message?: string };
        expect(json.code).toBe("VALIDATION_ERROR");
        expect(json.message).toContain(key);
        // Approval is a per-run decision the platform derives from the
        // authenticated launcher. Stripping the field instead of refusing it
        // would let a caller believe it had been honoured.
        expect(convexMutationMock).not.toHaveBeenCalled();
      }
    );

    it("refuses an approval field on PATCH too", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        { import: { status: "approximated", note: "ok", approvedBy: "u" } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it('refuses "exact" with no note', async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        { title: "t", steps: [PROMPT_STEP], import: { status: "exact" } }
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { message?: string };
      // `exact` is CONVERTER-CLAIMED, not verified — so it has to cite the
      // mapping rule that earns it.
      expect(json.message).toContain("converter-asserted, not verified");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("accepts sourceCaseKey and note exactly at their caps", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        {
          title: "t",
          steps: [PROMPT_STEP],
          import: {
            status: "approximated",
            sourceCaseKey: "k".repeat(512),
            note: "n".repeat(2000),
          },
        }
      );
      expect(res.status).toBe(201);
      expect(authoredCaseArgs().import.sourceCaseKey).toHaveLength(512);
      expect(authoredCaseArgs().import.note).toHaveLength(2000);
    });

    it.each([
      ["sourceCaseKey", { status: "approximated", sourceCaseKey: "k".repeat(513) }],
      ["note", { status: "approximated", note: "n".repeat(2001) }],
    ] as const)("refuses %s one character over its cap", async (_l, claim) => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        { title: "t", steps: [PROMPT_STEP], import: claim }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("refuses an unknown mapping status", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        {
          title: "t",
          steps: [PROMPT_STEP],
          import: { status: "approximate" },
        }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("strict write bodies", () => {
    const PROMPT_STEP = { id: "s1", kind: "prompt", prompt: "hi" };

    it.each([
      [
        "PATCH /eval-suites/:suiteId",
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        { name: "Renamed", hostz: [] },
        "hostz",
      ],
      [
        "PATCH /eval-suites/:suiteId/schedule",
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/schedule",
        { enabled: false, interval: 60 },
        "interval",
      ],
      [
        "POST /cases",
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases",
        { title: "t", steps: [PROMPT_STEP], kind: "prompt" },
        "kind",
      ],
      [
        "POST /cases/batch",
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
        {
          cases: [{ title: "t", steps: [PROMPT_STEP] }],
          dryRun: true,
        },
        "dryRun",
      ],
      [
        "PATCH /cases/:caseId",
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        { title: "n", query: "old field" },
        "query",
      ],
      [
        "POST /cases/generate",
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/cases/generate",
        { mode: "normal", count: 5 },
        "count",
      ],
    ] as const)(
      "rejects an unknown key on %s (400, names the key, no mutation)",
      async (_label, method, path, body, key) => {
        const res = await request(method, path, { ...body });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { code?: string; message?: string };
        expect(json.code).toBe("VALIDATION_ERROR");
        expect(json.message).toContain(key);
        expect(convexMutationMock).not.toHaveBeenCalled();
      }
    );

    it("names the field path on a typed-wrong declared key", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
        { name: 12 }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/^name:/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
