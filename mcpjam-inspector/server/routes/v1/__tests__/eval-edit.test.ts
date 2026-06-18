import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function defaultMutationImpl(name: string) {
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
    convexMutationMock.mockImplementation((name: string) =>
      defaultMutationImpl(name)
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
    expect(body.settings.judge).toEqual({
      enabled: true,
      model: "openai/gpt-5-mini",
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
    expect(args.environment).toEqual({ servers: ["Excalidraw (App)"] });
    expect(args.refreshHostConfigFromEnvironment).toBe(true);
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
    expect(body.schedule).toEqual({ enabled: false, intervalMinutes: 60 });
  });

  it("enabling a schedule without interval is a 400", async () => {
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
      { title: "bare", prompt: "hi", expectedToolCalls: [{ tool: "x" }] }
    );
    expect(res.status).toBe(201);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:createTestCase"
    )![1];
    // Provider resolved via the catalog, not dropped to [].
    expect(args.models).toEqual([
      { model: "claude-sonnet-4-5", provider: "anthropic" },
    ]);
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
    expect(item.kind).toBe("prompt");
    expect(item.prompt).toBe("What tools?");
    expect(item.iterations).toBe(1);
    expect(item.expectedToolCalls).toEqual([{ tool: "list" }]);
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

  it("PATCH on a render-check case honors a renderCheck-only patch (no kind)", async () => {
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
      { renderCheck: { server: "Excalidraw (App)", tool: "new_tool" } }
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase"
    )![1];
    // Routed to the render-check branch via the existing case's kind, not as a prompt.
    expect(args.probeConfig).toMatchObject({ toolName: "new_tool" });
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
        (c) => c[0] === "testSuites:createTestCase"
      )
    ).toBe(true);
  });
});
