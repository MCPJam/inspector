import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpaqueId } from "@mcpjam/sdk/contract";
import { MAX_CASES_PER_BATCH } from "../../shared/eval-case-batch.js";
import { upstreamRefusalFromResponse } from "../../../services/upstream-refusal.js";
import { Hono } from "hono";
import * as authoringHelpers from "../../../services/evals/route-helpers.js";

// Covers the v1 eval-edit surface: suite settings/schedule/delete + case CRUD
// + generate. Asserts public→internal translation, DTO scrubbing (no internal
// columns leak), project-scope guards, null-clears, schedule preserve-interval,
// environment edits without a live MCP connection, and generate persistence.

// The schedule PATCH refuses an ENABLE unless the deployment switch is on
// (`config.ts`, default OFF while Schedule is untested). These cases exercise
// the schedule's own semantics — interval reuse, environment pinning — which
// only exist past that guard, so the switch is on for this file. The guard
// itself is covered in `eval-schedule-write-switch.test.ts`.
vi.hoisted(() => {
  process.env.MCPJAM_SCHEDULED_EVALS_WRITE_ENABLED = "true";
});

const {
  validateGuestTokenMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexMutationMock,
  convexActionMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  convexActionMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js",
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
  token = "tok",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

/** The same request, announcing the canonical vocabulary. */
function requestV2(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return request(method, path, body, "tok", {
    "x-mcpjam-eval-vocabulary": "2",
  });
}

const SUITE_DOC = {
  _id: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
  _id: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
  testSuiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
        // Id-SHAPED, like every fixture id in this file: the v1 routes
        // now gate `:caseId` on the Convex id shape
        // (`convex-id-param.ts`), so a `case1xxxxxxxxxxxxxxxxxxxxxxxxxxx` that could never exist
        // in production would 404 before reaching this mock.
        testCaseId: `case${index + 1}`.padEnd(32, "x"),
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
    (c) => c[0] === "testSuites:createTestCases",
  );
  return call?.[1]?.cases?.[index];
}

/** The args of the most recent `testSuites:updateTestCase` call. */
function updateArgs(): any {
  const calls = convexMutationMock.mock.calls.filter(
    (c) => c[0] === "testSuites:updateTestCase",
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
  if (name === "testSuites:createTestCase")
    return Promise.resolve("case1xxxxxxxxxxxxxxxxxxxxxxxxxxx");
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
      defaultQueryImpl(name),
    );
    convexMutationMock.mockImplementation((name: string, args?: any) =>
      defaultMutationImpl(name, args),
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("GET suite returns a scrubbed public DTO (no internal columns)", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("suite1xxxxxxxxxxxxxxxxxxxxxxxxxx");
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
      threshold: 0.7,
      // S6 — the suite's own criteria, `null` when it has none. Distinct from
      // an empty list, which the write side refuses.
      rubric: null,
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
        ? Promise.resolve({
            ...SUITE_DOC,
            projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx",
          })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(404);
  });

  it("PATCH suite maps public settings to internal updateTestSuite args", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
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
      },
    );
    expect(res.status).toBe(200);
    const call = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { minimumIterations: 3 } },
    );
    expect(res.status).toBe(200);
    expect(
      convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestSuite",
      )![1].minIterations,
    ).toBe(3);

    vi.clearAllMocks();
    convexQueryMock.mockImplementation((name: string) =>
      defaultQueryImpl(name),
    );
    convexMutationMock.mockImplementation((name: string) =>
      defaultMutationImpl(name),
    );

    // `null` must arrive as null, not collapse to undefined — the platform
    // reads undefined as "leave alone", so a dropped null is a clear that
    // reports success and changes nothing.
    const cleared = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { minimumIterations: null } },
    );
    expect(cleared.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    expect(args).toHaveProperty("minIterations");
    expect(args.minIterations).toBeNull();
  });

  it("PATCH rejects a minimumIterations outside 1–10", async () => {
    for (const value of [0, 11, 2.5]) {
      vi.clearAllMocks();
      convexQueryMock.mockImplementation((name: string) =>
        defaultQueryImpl(name),
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { minimumIterations: value } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    }
  });

  it("GET reports minimumIterations, null when the suite has no floor", async () => {
    const unset = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(((await unset.json()) as any).settings.minimumIterations).toBeNull();

    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, minIterations: 4 })
        : defaultQueryImpl(name),
    );
    const set = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(((await set.json()) as any).settings.minimumIterations).toBe(4);
  });

  it("PATCH round-trips judge autoRun and threshold", async () => {
    // `autoRun` is the flag the grader gates on — a suite can be `enabled`
    // forever and never grade a run without it, which is exactly the gap the
    // API had while it accepted only `enabled` + `model`.
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { autoRun: true, threshold: 0.85 } } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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

  it("PATCH goal-completion preserves a stored groundedness slot", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            judgeConfig: {
              goalCompletion: {
                enabled: true,
                judgeModel: "openai/gpt-5-mini",
              },
              groundedness: { role: "advisory", judgeModel: "stored-g" },
            },
          })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { threshold: 0.9, severity: "warn" } } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    expect(args.judgeConfig).toEqual({
      goalCompletion: {
        enabled: true,
        judgeModel: "openai/gpt-5-mini",
        threshold: 0.9,
        severity: "warn",
      },
      groundedness: { role: "advisory", judgeModel: "stored-g" },
    });
  });

  it("PATCH refuses a groundedness write while unwired", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { groundedness: { enabled: true } } } },
    );
    expect(res.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("PATCH goal-completion preserves a stored rubric-checks slot", async () => {
    // The slot is app-only, so the public route can never write it, and
    // `updateTestSuite` replaces `judgeConfig` wholesale. Dropping it here
    // would switch a suite's rubric checks back to the defaults and erase its
    // authored questions on an unrelated threshold edit.
    const rubricChecks = {
      enabled: false,
      questions: [
        {
          id: "tone",
          kind: "choice",
          label: "Tone",
          instructions: "How did the reply sound?",
          options: [
            { id: "warm", label: "Warm" },
            { id: "curt", label: "Curt" },
          ],
          pass: { anyOf: ["warm"] },
        },
      ],
    };
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            judgeConfig: {
              goalCompletion: { enabled: true },
              groundedness: { role: "advisory", judgeModel: "stored-g" },
              rubricChecks,
            },
          })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { threshold: 0.9 } } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    expect(args.judgeConfig).toEqual({
      goalCompletion: { enabled: true, threshold: 0.9 },
      groundedness: { role: "advisory", judgeModel: "stored-g" },
      rubricChecks,
    });
  });

  it("PATCH refuses a rubric-checks write: the slot is app-only", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { rubricChecks: { enabled: false } } } },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/rubricChecks/);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("GET reports stored groundedness and severity without inventing defaults", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            judgeConfig: {
              goalCompletion: {
                enabled: true,
                judgeModel: "openai/gpt-5-mini",
                severity: "warn",
              },
              groundedness: {
                role: "advisory",
                judgeModel: "stored-g",
                threshold: 0.6,
              },
            },
          })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.judge.severity).toBe("warn");
    expect(body.settings.judge.groundedness).toEqual({
      role: "advisory",
      model: "stored-g",
      threshold: 0.6,
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { model: "openai/gpt-5" } } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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

  it("GET leaves inherited automation unknown when an older backend supplies no policy", async () => {
    // A suite that never touched the judge reports what a run WOULD grade
    // with, not a half-resolved `enabled: true` beside `model: null` — a
    // combination that never exists at run time.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, judgeConfig: undefined })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.judge).toEqual({
      enabled: true,
      model: "openai/gpt-5.4-mini",
      threshold: 0.7,
      rubric: null,
    });
  });

  it("GET reports the backend automatic policy for an untouched suite", async () => {
    convexQueryMock.mockImplementation((name: string) => name === "testSuites:getTestSuite"
      ? Promise.resolve({ ...SUITE_DOC, judgeConfig: undefined, judgePolicy: { contractVersion: 4, automatic: true, effective: { enabled: true, autoRun: true, judgeModel: "openai/gpt-5.4-mini", threshold: 0.7, role: "advisory" } } })
      : defaultQueryImpl(name));
    const res = await request("GET", "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.settings.judge).toMatchObject({ autoRun: true, automatic: true, contractVersion: 4 });
  });

  it("PATCH partial settings merge onto current values (no field reset)", async () => {
    // Only judge.model and only matchOptions.arguments — everything else must
    // be preserved from the suite's current settings.
    const resJudge = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { judge: { model: "openai/gpt-5" } } },
    );
    expect(resJudge.status).toBe(200);
    const judgeArgs = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    // enabled (true) preserved from current; only judgeModel changed.
    expect(judgeArgs.judgeConfig).toEqual({
      goalCompletion: { enabled: true, judgeModel: "openai/gpt-5" },
    });

    vi.clearAllMocks();
    convexQueryMock.mockImplementation((name: string) =>
      defaultQueryImpl(name),
    );
    convexMutationMock.mockImplementation((name: string) =>
      defaultMutationImpl(name),
    );

    const resMatch = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { settings: { matchOptions: { arguments: "partial" } } },
    );
    expect(resMatch.status).toBe(200);
    const matchArgs = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        environment: { servers: ["Excalidraw (App)"] },
      },
    );
    expect(res.status).toBe(200);
    expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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
          {
            environmentId: "img_1",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            name: "Playwright",
          },
          {
            environmentId: "img_2",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            name: "Node 22",
          },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { computerEnvironment: "playwright" } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { computerEnvironment: null } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { servers: ["Excalidraw (App)", "Other"] } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    expect(args.environment.computerEnvironmentId).toBe("img_1");
    expect(args.environment.servers).toEqual(["Excalidraw (App)", "Other"]);
  });

  it("PATCH on an environment suite sends its environments' settings, not the legacy envelope", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite")
        return Promise.resolve({
          ...SUITE_DOC,
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
          environment: {
            ...SUITE_DOC.environment,
            computerEnvironmentId: "img_stale",
          },
        });
      if (name === "projectEnvironments:getCapabilities")
        return Promise.resolve({ environmentSuiteSettings: true });
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { servers: ["Other"], computerEnvironment: null } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    // `null` reaches the platform as a clear of every environment's image;
    // the stale suite pin is neither carried nor compared.
    expect(args.environmentSettings).toEqual({
      servers: ["Other"],
      computerEnvironmentId: null,
    });
    expect(args.environment).toBeUndefined();
    expect(args.refreshHostConfigFromEnvironment).toBeUndefined();
  });

  it("PATCH on an environment suite keeps the legacy envelope on an older platform", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({
            ...SUITE_DOC,
            environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
          })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { servers: ["Other"] } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];
    expect(args.environmentSettings).toBeUndefined();
    expect(args.environment.servers).toEqual(["Other"]);
  });

  it("PATCH an unknown computer image 404s and names the real choices", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "computerEnvironments:listEnvironments") {
        return Promise.resolve([
          {
            environmentId: "img_1",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            name: "Playwright",
          },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { computerEnvironment: "ghost" } },
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
          {
            environmentId: "img_1",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            name: "Playwright",
          },
          {
            environmentId: "img_2",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            name: "playwright",
          },
        ]);
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { environment: { computerEnvironment: "Playwright" } },
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
          projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
          name: "Playwright",
        });
      }
      return defaultQueryImpl(name);
    });
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.environment.computerEnvironment).toEqual({
      id: "img_1",
      name: "Playwright",
    });
  });

  it("GET reports an unpinned suite's computer image as null", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
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
              },
        );
      }
      if (name === "hosts:listHosts")
        return Promise.resolve([
          { hostId: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Prod" },
        ]);
      return defaultQueryImpl(name);
    });

    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        environment: { servers: ["New Server"] },
        hosts: [{ host: "Prod", servers: ["New Server"] }],
      },
    );
    expect(res.status).toBe(200);
    const hostCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite" && c[1].hostAttachments,
    );
    expect(hostCall![1].hostAttachments).toEqual([
      {
        namedHostId: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        selectedServerIds: ["srv_new"],
      },
    ]);
    // The suite was re-read (twice) so the new server's binding was visible.
    expect(suiteReads).toBeGreaterThanOrEqual(2);
  });

  it("PATCH hosts.servers resolves a projectServerId as well as a bound name", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "hosts:listHosts")
        return Promise.resolve([
          { hostId: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Prod" },
        ]);
      return defaultQueryImpl(name);
    });

    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        hosts: [
          { host: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx", servers: ["srv_1"] },
        ],
      },
    );
    expect(res.status).toBe(200);
    const hostCall = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite" && c[1].hostAttachments,
    );
    expect(hostCall![1].hostAttachments).toEqual([
      {
        namedHostId: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        selectedServerIds: ["srv_1"],
      },
    ]);
  });

  it("PATCH suite rejects the hostIds/servers near-miss (400, names the keys)", async () => {
    // The reported silent no-op: undeclared top-level keys used to 200 with
    // hosts: [] and zero mutations. Strict body + path-aware errors name them.
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        hostIds: ["host1xxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        servers: ["Excalidraw (App)"],
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        executionConfig: { temperature: 0.9 },
      },
    );
    expect(res.status).toBe(200);
    const call = convexMutationMock.mock.calls.find(
      (c) => c[0] === "hostConfigsV2:setSuiteConfig",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      { enabled: false },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:setSuiteSchedule",
    )![1];
    expect(args.enabled).toBe(false);
    const body = (await res.json()) as any;
    expect(body.schedule).toEqual({
      enabled: false,
      intervalMinutes: 60,
      // Project-environment schedule pin (read-only DTO field); this suite
      // has none.
      environmentId: null,
      // B9b — the schedule's own state, owner and next firing. A schedule that
      // paused itself keeps `enabled: true`, so these are the fields that tell
      // a caller whether it is actually running.
      state: null,
      createdBy: null,
      nextDueAt: null,
      consecutiveFailures: 0,
    });
  });

  it("re-enabling without interval reuses the suite's saved interval", async () => {
    // SUITE_DOC.schedule.intervalMinutes === 60 (e.g. after a disable).
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      { enabled: true },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:setSuiteSchedule",
    )![1];
    // No interval forwarded — the backend reuses the saved one.
    expect(args).toEqual({
      suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      enabled: true,
    });
  });

  describe("project-environment attachments", () => {
    const ENV_SUITE = {
      ...SUITE_DOC,
      environmentIds: [
        "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ],
    };
    const ENVIRONMENT_ROWS = [
      { environmentId: "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Staging" },
      { environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Prod" },
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
      mockEnvSuite([
        "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        {
          enabled: true,
          intervalMinutes: 60,
          environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteSchedule",
      )![1];
      expect(args).toEqual({
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        enabled: true,
        intervalMinutes: 60,
        environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });
    });

    it("defaults the schedule pin on a single-environment suite", async () => {
      mockEnvSuite(["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        { enabled: true },
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteSchedule",
      )![1];
      expect(args.environmentId).toBe("env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    });

    it("400s an unpinned enable on a multi-environment suite, naming both", async () => {
      mockEnvSuite([
        "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        { enabled: true },
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
          (c) => c[0] === "testSuites:setSuiteSchedule",
        ),
      ).toBe(false);
    });

    it("400s an environment that the suite has not attached", async () => {
      mockEnvSuite(["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        { enabled: true, environmentId: "envghostxxxxxxxxxxxxxxxxxxxxxxxx" },
      );
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason,
      ).toBe("ENVIRONMENT_NOT_ATTACHED");
    });

    it("400s an environment sent with a disable rather than dropping it", async () => {
      mockEnvSuite(["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        { enabled: false, environmentId: "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toContain(
        "only applies when enabling",
      );
    });

    it("PATCH suite forwards environmentIds to setSuiteEnvironments", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: [
            "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          ],
        },
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments",
      )![1];
      expect(args).toEqual({
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        environmentIds: [
          "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ],
        // B9b — every write in one PATCH shares one revision group, so the
        // suite's history records one edit rather than several.
        revision: { source: "api", groupId: expect.any(String) },
      });
    });

    it("PATCH suite clears attachments with an explicit null", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: null,
        },
      );
      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments",
      )![1];
      expect(args.environmentIds).toBeNull();
    });

    it("PATCH suite rejects [] instead of treating it as a clear", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: [],
        },
      );
      expect(res.status).toBe(400);
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteEnvironments",
        ),
      ).toBe(false);
    });

    it("PATCH rejects a stranding environment change before applying the legacy edits", async () => {
      // Enabled schedule pinned to env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx, which the change drops.
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              environmentIds: [
                "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              ],
              schedule: {
                enabled: true,
                intervalMinutes: 60,
                environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              },
            })
          : defaultQueryImpl(name),
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          name: "Renamed",
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        },
      );

      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason,
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
          : defaultQueryImpl(name),
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: [
            "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          ],
        },
      );

      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { details?: { reason?: string } }).details
          ?.reason,
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
              environmentIds: [
                "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              ],
              schedule: {
                enabled: false,
                intervalMinutes: 60,
                environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              },
            })
          : defaultQueryImpl(name),
      );

      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        },
      );

      expect(res.status).toBe(200);
      const args = convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:setSuiteEnvironments",
      )![1];
      expect(args.environmentIds).toEqual(["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
    });

    it("PATCH suite leaves attachments alone when the field is omitted", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          name: "Renamed",
        },
      );
      expect(res.status).toBe(200);
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteEnvironments",
        ),
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
                environmentId: "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              },
            })
          : defaultQueryImpl(name),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const body = (await res.json()) as any;
      expect(body.environmentIds).toEqual([
        "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ]);
      expect(body.schedule.environmentId).toBe(
        "env2xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
    });
  });

  it("enabling without interval AND no saved interval is a 400", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve({ ...SUITE_DOC, schedule: undefined })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      { enabled: true },
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    const body = (await res.json()) as any;
    expect(body.settings.matchOptions.extraToolCalls).toBe("unlimited");
  });

  it("PATCH case merges partial match options onto the existing override", async () => {
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { matchOptions: { arguments: "exact" } },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { steps: [{ id: "s1", kind: "prompt", prompt: "updated" }] },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
      },
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
      },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase",
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      deleted: true,
    });
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:deleteTestSuite",
      ),
    ).toBe(true);
  });

  it("create case without models derives the provider for a bare suite default", async () => {
    // Suite execution config stores a BARE model id (no slash).
    convexQueryMock.mockImplementation((name: string) =>
      name === "hostConfigsV2:getSuiteConfig"
        ? Promise.resolve({ ...EXEC_CONFIG, modelId: "claude-sonnet-4-5" })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
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
      },
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        {
          title: "vendor",
          steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
          models: [{ model }],
        },
      );
      expect(res.status).toBe(201);
      const args = authoredCaseArgs();
      expect(args.models).toEqual([{ model, provider }]);
    },
  );

  it("falls back to the vendor PREFIX for a qualified id nothing knows", async () => {
    // Not in the catalog and not in the prefix map. `ollama` is the
    // classifier's answer for a BARE id; for a qualified one the vendor the
    // author wrote is strictly better information than a guess.
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "unknown vendor",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        // No explicit `provider`: `deriveProvider` returns an explicit one
        // verbatim, so passing it would satisfy the assertion without ever
        // reaching the fallback under test.
        models: [{ model: "newvendor/some-model" }],
      },
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
        : defaultQueryImpl(name),
    );
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "inherits",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "padded",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        models: [{ model: "  openai/gpt-5  " }],
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "blank",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        models: [entry],
      },
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases",
      ),
    ).toBe(false);
  });

  it("GET cases returns scrubbed public case DTOs", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const item = body.items[0];
    expect(item.id).toBe("case1xxxxxxxxxxxxxxxxxxxxxxxxxxx");
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { matchOptions: null, checks: null },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase",
    )![1];
    expect(args.matchOptions).toBeNull();
    expect(args.predicates).toBeNull();
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
      },
    );
    expect(res.status).toBe(200);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestCase",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      deleted: true,
    });
  });

  /**
   * Generation runs the shared authoring job. What this layer still owns is
   * what it hands the job, how it answers while the job is unfinished, and how
   * a refusal the BACKEND made reaches the caller — the drafting itself, the
   * per-case idempotency and the spend accounting are the job's, and are
   * tested against the worker in the backend repo.
   */
  function authoringBackend(init?: {
    start?: Response;
    status?: Record<string, unknown> | null;
  }) {
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const capture = vi
      .spyOn(authoringHelpers, "captureToolSnapshotForEvalAuthoring")
      .mockResolvedValue({ toolSnapshot: [] } as any);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        init?.start ??
          Response.json(
            { version: 1, jobId: "job", status: "pending" },
            { status: 202 },
          ),
      );
    authoringStatus =
      init?.status === undefined
        ? {
            jobId: "job",
            projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
            source: "generation",
            status: "completed",
            drafts: [],
          }
        : init.status;
    return {
      capture,
      fetchMock,
      /** The job body the route posted to the backend. */
      sent: () =>
        JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
      restore: () => {
        capture.mockRestore();
        fetchMock.mockRestore();
        authoringStatus = null;
        delete process.env.CONVEX_HTTP_URL;
      },
    };
  }

  /** A draft the job finished, ready to commit. */
  function finishedDraft(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      draftId: "d1",
      revision: 0,
      case: {
        title: "Generated A",
        steps: [{ id: "p", kind: "prompt", prompt: "do a thing" }],
        expectedOutput: "A thing happened",
      },
      issues: [],
      additions: [],
      review: "required",
      ...overrides,
    };
  }

  it("generate commits the job's drafts and reports the generation model", async () => {
    const backend = authoringBackend({
      status: {
        jobId: "job",
        projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        source: "generation",
        status: "completed",
        drafts: [finishedDraft()],
      },
    });
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "evalAuthoringState:prepareCommit")
        return Promise.resolve({ title: "Generated A" });
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: [{ index: 0, testCaseId: "case_1" }],
            failed: [],
          },
        });
      return defaultMutationImpl(name, args);
    });
    try {
      const res = await generateWith({ body: { mode: "normal" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.generationModel).toBe("anthropic/claude-haiku-4.5");
      expect(body.created).toHaveLength(1);
      expect(backend.sent()).toMatchObject({ source: "generation" });
    } finally {
      backend.restore();
    }
  });

  /**
   * The public contract `$ref`s `RateLimited` (which documents `Retry-After`)
   * from almost every operation. The refusal is the BACKEND's — the customer's
   * own exhausted allowance — so reporting it as `SERVER_UNREACHABLE` would
   * leave a CI caller no code to branch on, no window to wait for, and would
   * count the refusal against MCPJam's own 5xx monitors.
   */
  it("generate answers a backend platform_capacity 429 as RATE_LIMITED with Retry-After", async () => {
    const backend = authoringBackend({
      start: Response.json(
        {
          ok: false,
          code: "platform_capacity",
          error: "MCPJam generation is at capacity. Try again shortly.",
          retryAfterMs: 45_000,
        },
        { status: 429 },
      ),
    });
    try {
      const res = await generateWith({ body: { mode: "normal" } });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("45");
      const body = (await res.json()) as any;
      expect(body.code).toBe("RATE_LIMITED");
      expect(body.message).toContain("at capacity");
    } finally {
      backend.restore();
    }
  });

  it("generate answers 202 with the job id when the wait runs out", async () => {
    // A disconnect is the same shape as the window expiring, and is the only
    // way to reach it without waiting out the real 15 seconds.
    const backend = authoringBackend({
      status: {
        jobId: "job",
        projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        source: "generation",
        status: "pending",
        drafts: [],
      },
    });
    try {
      const res = await generateWith({
        body: { mode: "normal" },
        signal: AbortSignal.abort(),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ jobId: "job" });
    } finally {
      backend.restore();
    }
  });

  // A case the model was unsure about is not written unattended: the app keeps
  // it out of "Add all" behind "Save anyway", and the API has nobody to ask.
  // The skip has to NAME the doubt, or a CLI user learns only that something
  // was wrong and has to open a browser to find out what.
  it("generate skips a draft the model was unsure about, and says why", async () => {
    const backend = authoringBackend({
      status: {
        jobId: "job",
        projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        source: "generation",
        status: "completed",
        drafts: [
          finishedDraft({
            case: {
              title: "Bad draft",
              steps: [{ id: "p", kind: "prompt", prompt: "x" }],
              expectedOutput: "y",
            },
            issues: [
              {
                code: "unknown_tool",
                message: "Tool nope is missing or ambiguous.",
                blocking: false,
                origin: "validation",
              },
            ],
          }),
        ],
      },
    });
    try {
      const res = await generateWith({ body: { mode: "normal" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.created).toHaveLength(0);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].title).toBe("Bad draft");
      expect(body.skipped[0].error).toContain(
        "names tools this server does not have",
      );
    } finally {
      backend.restore();
    }
  });

  // An addition is the model filling a gap the document left, and it is
  // already IN the steps. The app approves them all when the reader presses
  // save, so the API refusing them meant handing back a link to a one-click
  // save of the case we had just declined to write.
  it("generate commits a draft whose only note is an addition", async () => {
    const backend = authoringBackend({
      status: {
        jobId: "job",
        projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        source: "generation",
        status: "completed",
        drafts: [
          finishedDraft({
            case: {
              title: "Completed draft",
              steps: [{ id: "p", kind: "prompt", prompt: "x" }],
              expectedOutput: "y",
            },
            additions: [{ id: "a", path: "steps.0", explanation: "Added" }],
          }),
        ],
      },
    });
    let accepted: any;
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "evalAuthoringState:acceptDraft") {
        accepted = args;
        return Promise.resolve(null);
      }
      if (name === "evalAuthoringState:prepareCommit")
        return Promise.resolve({ title: "Completed draft" });
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: [{ index: 0, testCaseId: "case_1" }],
            failed: [],
          },
        });
      return defaultMutationImpl(name, args);
    });
    try {
      const res = await generateWith({ body: { mode: "normal" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.skipped ?? []).toHaveLength(0);
      expect(body.created).toHaveLength(1);
      // The draft's own addition ids, not `[]`: the backend refuses to accept
      // a draft with an unapproved addition, so sending none meant the commit
      // could never succeed for a case the model had completed.
      expect(accepted.acceptedAdditionIds).toEqual(["a"]);
    } finally {
      backend.restore();
    }
  });

  it("generate discovers tools from the suite's environment, not its saved selection", async () => {
    const backend = authoringBackend();
    try {
      const res = await generateWith({
        body: {},
        query: (name) => {
          if (name === "testSuites:getTestSuite")
            return Promise.resolve({
              ...SUITE_DOC,
              environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
            });
          if (name === "projectEnvironments:resolveEnvironmentForLaunch")
            return Promise.resolve({
              environmentRef: {
                environmentId: "env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                name: "Staging",
                revision: 3,
              },
              hostId: "host1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
              selectedServerIds: ["srv_env"],
              servers: [{ serverId: "srv_env_live", name: "env server" }],
            });
          return undefined;
        },
      });
      expect(res.status).toBe(200);
      // The environment's closed set is connected; the legacy rollback
      // selection is never read — cases authored against it would describe
      // tools the suite's runs never see.
      expect(createAuthorizedManagerMock.mock.calls[0][3]).toEqual([
        "srv_env_live",
      ]);
      expect(convexQueryMock).not.toHaveBeenCalledWith(
        "testSuites:getSuiteRunServerSelection",
        expect.anything(),
      );
    } finally {
      backend.restore();
    }
  });

  /** The authoring job `startAuthoringJobAndAwait` polls, set per test. */
  let authoringStatus: Record<string, unknown> | null = null;

  /** The suite's servers resolve; nothing else is stubbed for the caller. */
  function withResolvedServers() {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "evalAuthoringState:status")
        return Promise.resolve(authoringStatus);
      if (name === "testSuites:getSuiteRunServerSelection")
        return Promise.resolve({ serverIds: ["srv_1"], serverNames: ["S"] });
      return defaultQueryImpl(name);
    });
  }

  it.each(["", "<html>upstream error</html>"])("maps non-JSON generation replies to 502: %j", async (body) => {
    const oldFlag = process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
    const oldUrl = process.env.CONVEX_HTTP_URL;
    process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = "true";
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const capture = vi.spyOn(authoringHelpers, "captureToolSnapshotForEvalAuthoring").mockResolvedValue({ toolSnapshot: [] } as any);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 503 }));
    try {
      const response = await generateWith({});
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "SERVER_UNREACHABLE" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
      fetchMock.mockRestore();
      if (oldFlag === undefined) delete process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
      else process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = oldFlag;
      if (oldUrl === undefined) delete process.env.CONVEX_HTTP_URL;
      else process.env.CONVEX_HTTP_URL = oldUrl;
    }
  });

  it.each(["failed", "cancelled", "pending", "completed"])("returns %s authoring jobs without missing-collection crashes", async (status) => {
    convexQueryMock.mockImplementation((name: string) => name === "evalAuthoringState:status"
      ? Promise.resolve({ jobId: "job", projectId: "p1", suiteId: "s1", source: "generation", status, error: "Stopped" }) : defaultQueryImpl(name));
    const response = await request("POST", "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status, error: "Stopped" });
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])("returns 404 for absent authoring jobs on %s", async (method) => {
    convexQueryMock.mockResolvedValue(null);
    const response = await request(method, `/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${method === "POST" ? "/commit" : ""}`, method === "POST" ? {} : undefined);
    expect(response.status).toBe(404);
  });
  it("omits unavailable case reads from receipts and counts", async () => {
    convexQueryMock.mockImplementation((name: string, args: any) => {
      if (name === "evalAuthoringState:status") return Promise.resolve({ jobId: "job", projectId: "p1", suiteId: "s1", source: "generation", status: "completed", committedCaseIds: ["valid", "missing", "unreadable"] });
      if (name === "testSuites:getTestCase") {
        if (args.testCaseId === "unreadable") return Promise.reject(new Error("Not accessible"));
        return Promise.resolve(args.testCaseId === "valid" ? CASE_DOC : null);
      }
      return defaultQueryImpl(name);
    });
    const response = await request("POST", "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit", {});
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.created).toHaveLength(1);
    expect(result.counts).toEqual({ normal: 1, negative: 0 });
  });

  it("keeps review skips and normalizes batch failure messages", async () => {
    const draft = { version: 1, draftId: "draft", revision: 0, case: { title: "Save failed", steps: [{ id: "p", kind: "prompt", prompt: "Find a document" }], expectedOutput: "Document found" }, issues: [], additions: [], review: "required" };
    convexQueryMock.mockResolvedValue({ jobId: "job", projectId: "p1", suiteId: "s1", source: "generation", status: "completed", drafts: [
      { ...draft, draftId: "review", case: { ...draft.case, title: "Needs review" }, issues: [{ code: "unknown_tool", message: "Tool nope is missing or ambiguous.", blocking: false, origin: "validation" }] }, draft,
    ] });
    convexMutationMock.mockImplementation((name: string) => {
      if (name === "evalAuthoringState:prepareCommit") return Promise.resolve({ title: "Save failed" });
      if (name === "testSuites:createTestCases") return Promise.resolve({ caseUpsert: { committed: [], failed: [{ index: 0, code: "DUPLICATE", message: "Already exists" }] } });
      return Promise.resolve(null);
    });
    const response = await request("POST", "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit", {});
    expect(response.status).toBe(200);
    // The skip NAMES the doubt. "Review this draft in the suite" told a CLI
    // caller that something was wrong without saying what.
    expect((await response.json()).skipped).toEqual([
      { title: "Needs review", error: "This case names tools this server does not have. Open the review link to read it and save it anyway." },
      { title: "Save failed", error: "Already exists" },
    ]);
  });

  async function generateWith(init: {
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    /** Applied AFTER `withResolvedServers`, which otherwise clobbers it. */
    query?: (name: string) => Promise<unknown> | undefined;
    /** Ends the compatibility wait early, the way a disconnect does. */
    signal?: AbortSignal;
  }) {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    withResolvedServers();
    if (init.query) {
      const base = convexQueryMock.getMockImplementation()!;
      convexQueryMock.mockImplementation((name: string, ...rest: unknown[]) => {
        const override = init.query!(name);
        return override ?? (base as any)(name, ...rest);
      });
    }
    return makeApp().request(
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          ...(init.headers ?? {}),
        },
        body: JSON.stringify({ mode: "normal", ...(init.body ?? {}) }),
        ...(init.signal ? { signal: init.signal } : {}),
      },
    );
  }

  /**
   * Document import: the same authoring job as generation, reached with a
   * document instead of a brief. What is worth pinning is the part that is
   * NOT shared — the gate, the forwarded payload, and the fact that a partial
   * result hands back a way to finish it that is not "send it all again".
   */
  async function importWith(init: {
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    /** Applied AFTER `withResolvedServers`, which otherwise clobbers it. */
    query?: (name: string) => Promise<unknown> | undefined;
    /** Ends the compatibility wait early, the way a disconnect does. */
    signal?: AbortSignal;
  }) {
    createAuthorizedManagerMock.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    withResolvedServers();
    if (init.query) {
      const base = convexQueryMock.getMockImplementation()!;
      convexQueryMock.mockImplementation((name: string, ...rest: unknown[]) => {
        const override = init.query!(name);
        return override ?? (base as any)(name, ...rest);
      });
    }
    return makeApp().request(
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/import",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
          ...(init.headers ?? {}),
        },
        body: JSON.stringify({
          content: "# Case 1\nSearch for coffee.",
          ...(init.body ?? {}),
        }),
        ...(init.signal ? { signal: init.signal } : {}),
      },
    );
  }

  // The backend hashes the job input to decide whether a replayed idempotency
  // key is the SAME request. Resolving the suite's model into the payload put
  // a value the caller never sent into that hash, so a suite whose model
  // changed between a timeout and the retry made the retry look like a
  // different request: it died with "Idempotency key was reused with a
  // different request" for a caller who had sent byte-identical bytes twice.
  //
  // Nothing is lost by omitting it: a case with no models inherits the suite's
  // model at RUN time, which is where the runner can see keys this route
  // cannot.
  it("sends the same import payload after the suite's model changes", async () => {
    const oldUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const payloadFor = async (modelId: string) => {
      const backend = authoringBackend({
        status: {
          jobId: "job",
          projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
          suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
          source: "import",
          status: "completed",
          drafts: [],
        },
      });
      try {
        await importWith({
          body: { idempotencyKey: "same-key" },
          query: (name) =>
            name === "hostConfigsV2:getSuiteConfig"
              ? Promise.resolve({ modelId })
              : undefined,
        });
        return backend.sent();
      } finally {
        backend.restore();
      }
    };
    try {
      const first = await payloadFor("claude-sonnet-4-5");
      const second = await payloadFor("claude-haiku-4-5");
      expect(second).toEqual(first);
      // The caller named no model, so the job carries none.
      expect(first.options?.caseModels).toBeUndefined();
    } finally {
      if (oldUrl === undefined) delete process.env.CONVEX_HTTP_URL;
      else process.env.CONVEX_HTTP_URL = oldUrl;
    }
  });

  // Same hash, same failure, same fix as the import test above.
  it("sends the same generate payload after the suite's model changes", async () => {
    const payloadFor = async (modelId: string) => {
      const backend = authoringBackend();
      try {
        await generateWith({
          body: { mode: "normal" },
          headers: { "Idempotency-Key": "same-key" },
          query: (name) =>
            name === "hostConfigsV2:getSuiteConfig"
              ? Promise.resolve({ modelId })
              : undefined,
        });
        return backend.sent();
      } finally {
        backend.restore();
      }
    };
    const first = await payloadFor("claude-sonnet-4-5");
    const second = await payloadFor("claude-haiku-4-5");
    expect(second).toEqual(first);
    expect(first.options).not.toHaveProperty("caseModels");
  });

  it("still forwards the models the caller names", async () => {
    const oldUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const backend = authoringBackend({
      status: {
        jobId: "job",
        projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        source: "import",
        status: "completed",
        drafts: [],
      },
    });
    try {
      await importWith({
        body: { caseModels: [{ model: "claude-haiku-4-5" }] },
      });
      expect(backend.sent().options.caseModels).toEqual([
        expect.objectContaining({ model: "claude-haiku-4-5" }),
      ]);
    } finally {
      backend.restore();
      if (oldUrl === undefined) delete process.env.CONVEX_HTTP_URL;
      else process.env.CONVEX_HTTP_URL = oldUrl;
    }
  });

  it("forwards the document and a defaulted file name", async () => {
    const oldFlag = process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
    const oldUrl = process.env.CONVEX_HTTP_URL;
    process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = "true";
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const capture = vi
      .spyOn(authoringHelpers, "captureToolSnapshotForEvalAuthoring")
      .mockResolvedValue({ toolSnapshot: [] } as any);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { version: 1, jobId: "job", status: "pending" },
          { status: 202 },
        ),
      );
    try {
      const response = await importWith({
        body: { content: "title,prompt\nA,B" },
        // Completed on the first poll. What this test is about is the payload
        // we hand the backend, and leaving the job pending only bought a
        // 15-second wait for the compatibility window to expire.
        query: (name) =>
          name === "evalAuthoringState:status"
            ? Promise.resolve({
                jobId: "job",
                projectId: "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
                suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
                source: "import",
                status: "completed",
                drafts: [],
              })
            : undefined,
      });
      expect(response.status).toBe(200);
      const sent = JSON.parse(
        (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
      );
      expect(sent).toMatchObject({
        source: "import",
        content: "title,prompt\nA,B",
        // A pasted document has no file behind it, and nothing is gated on
        // the name — it is only the label a reviewer sees.
        fileName: "import.txt",
      });
    } finally {
      capture.mockRestore();
      fetchMock.mockRestore();
      if (oldFlag === undefined)
        delete process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
      else process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = oldFlag;
      if (oldUrl === undefined) delete process.env.CONVEX_HTTP_URL;
      else process.env.CONVEX_HTTP_URL = oldUrl;
    }
  });

  it("answers 202 with a job id when the wait runs out", async () => {
    // The caller disconnecting is what ends the wait early here; a real slow
    // job ends it by the clock. Either way the job is NOT cancelled — the id
    // is how the caller comes back for it.
    const oldFlag = process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
    const oldUrl = process.env.CONVEX_HTTP_URL;
    process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = "true";
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    const capture = vi
      .spyOn(authoringHelpers, "captureToolSnapshotForEvalAuthoring")
      .mockResolvedValue({ toolSnapshot: [] } as any);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { version: 1, jobId: "job", status: "pending" },
          { status: 202 },
        ),
      );
    try {
      const response = await importWith({
        signal: AbortSignal.abort(),
        query: (name) =>
          name === "evalAuthoringState:status"
            ? Promise.resolve({ jobId: "job", status: "pending" })
            : undefined,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ jobId: "job" });
    } finally {
      capture.mockRestore();
      fetchMock.mockRestore();
      if (oldFlag === undefined)
        delete process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
      else process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = oldFlag;
      if (oldUrl === undefined) delete process.env.CONVEX_HTTP_URL;
      else process.env.CONVEX_HTTP_URL = oldUrl;
    }
  });

  it("refuses a document over the 100 KiB ceiling", async () => {
    const oldFlag = process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
    process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = "true";
    try {
      const response = await importWith({
        body: { content: "x".repeat(100 * 1024 + 1) },
      });
      expect(response.status).toBe(400);
    } finally {
      if (oldFlag === undefined)
        delete process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED;
      else process.env.EVAL_AUTHORING_GENERATION_V1_ENABLED = oldFlag;
    }
  });

  it("commits an import job, and still refuses the app's Markdown job", async () => {
    // The app's Markdown drafts exist so a PERSON decides on them; an API
    // commit would decide on their behalf. Import carries its own source and
    // is committable, which is the whole reason the two are not one value.
    for (const [source, expected] of [
      ["import", 200],
      ["markdown", 404],
    ] as const) {
      convexQueryMock.mockImplementation((name: string) =>
        name === "evalAuthoringState:status"
          ? Promise.resolve({
              jobId: "job",
              projectId: "p1",
              suiteId: "s1",
              source,
              status: "completed",
              drafts: [],
            })
          : defaultQueryImpl(name),
      );
      const response = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit",
        {},
      );
      expect(response.status).toBe(expected);
    }
  });

  it("hands back a review link for the cases it could not finish", async () => {
    // A skipped draft is not lost — it stays on the job. The link is what
    // lets a caller stop: without it the only move is re-sending the whole
    // document, which re-authors every case in it.
    //
    // A doubt is what holds a case back, not an addition: an addition is the
    // model completing the case, and the API commits those the way the app
    // does when the reader presses save.
    const draft = {
      version: 1,
      draftId: "review",
      revision: 0,
      case: {
        title: "Needs review",
        steps: [{ id: "p", kind: "prompt", prompt: "Browse groceries" }],
        expectedOutput: "The list renders",
      },
      issues: [
        {
          code: "missing_evidence",
          message: "A widget locator is missing.",
          blocking: false,
          origin: "validation",
        },
      ],
      additions: [],
      review: "required",
    };
    convexQueryMock.mockResolvedValue({
      jobId: "job77",
      projectId: "p1",
      suiteId: "s1",
      source: "import",
      status: "completed",
      drafts: [draft],
    });
    const response = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit",
      {},
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.skipped).toHaveLength(1);
    expect(result.reviewUrl).toContain("/evaluate/suite/s1");
    expect(result.reviewUrl).toContain("importJob=job77");
  });

  it("omits the review link when every case landed", async () => {
    convexQueryMock.mockResolvedValue({
      jobId: "job77",
      projectId: "p1",
      suiteId: "s1",
      source: "import",
      status: "completed",
      drafts: [],
    });
    const response = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit",
      {},
    );
    expect(await response.json()).not.toHaveProperty("reviewUrl");
  });

  it("carries a commit-time duplicate policy into the case writer", async () => {
    convexQueryMock.mockResolvedValue({
      jobId: "job",
      projectId: "p1",
      suiteId: "s1",
      source: "import",
      status: "completed",
      drafts: [
        {
          version: 1,
          draftId: "d",
          revision: 0,
          case: {
            title: "Search",
            steps: [{ id: "p", kind: "prompt", prompt: "Find my projects" }],
            expectedOutput: "Projects listed",
          },
          issues: [],
          additions: [],
          review: "required",
        },
      ],
    });
    convexMutationMock.mockImplementation((name: string) => {
      if (name === "evalAuthoringState:prepareCommit")
        return Promise.resolve({ title: "Search" });
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: { committed: [], failed: [] },
        });
      return Promise.resolve(null);
    });
    const response = await request(
      "POST",
      "/api/v1/projects/p1/eval-suites/s1/authoring/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit",
      { duplicatePolicy: "warn", overrideReason: "Re-importing a fixed case" },
    );
    expect(response.status).toBe(200);
    expect(
      convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:createTestCases",
      )?.[1],
    ).toMatchObject({
      duplicatePolicy: "warn",
      overrideReason: "Re-importing a fixed case",
    });
  });

  /**
   * The key the caller sent must reach the JOB, because that is where a replay
   * is now recognized. The failure this guards is silent: a key goes out on
   * the wire, nothing reads it, and every retry re-authors and re-spends.
   */
  function sentRequestKey(fetchMock: { mock: { calls: unknown[][] } }): string {
    return JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ).requestKey;
  }

  it.each([
    ["a BODY key", {}, { idempotencyKey: "body-key" }, "body-key"],
    [
      "the SDK client's transport header",
      { "idempotency-key": "sdk-key" },
      {},
      "sdk-key",
    ],
    [
      "the prefixed header",
      { "x-mcpjam-idempotency-key": "prefixed" },
      {},
      "prefixed",
    ],
  ])(
    "generate carries %s into the job's request key",
    async (_label, headers, body, expected) => {
      const backend = authoringBackend();
      try {
        await generateWith({
          headers: headers as Record<string, string>,
          body: { mode: "normal", ...(body as Record<string, unknown>) },
        });
        expect(sentRequestKey(backend.fetchMock)).toBe(expected);
      } finally {
        backend.restore();
      }
    },
  );

  it("generate lets the prefixed HEADER win over both other channels", async () => {
    const backend = authoringBackend();
    try {
      await generateWith({
        headers: {
          "x-mcpjam-idempotency-key": "prefixed",
          "idempotency-key": "plain",
        },
        body: { mode: "normal", idempotencyKey: "body" },
      });
      expect(sentRequestKey(backend.fetchMock)).toBe("prefixed");
    } finally {
      backend.restore();
    }
  });

  it("generate still starts a job when no key is sent", async () => {
    // Keyless is legal; the job simply gets a fresh key of its own, so a
    // retry is a new job rather than a replay.
    const backend = authoringBackend();
    try {
      await generateWith({ body: { mode: "normal" } });
      expect(sentRequestKey(backend.fetchMock)).toEqual(expect.any(String));
    } finally {
      backend.restore();
    }
  });

  it("generate forwards the generation knobs as job options", async () => {
    const backend = authoringBackend();
    try {
      const res = await generateWith({
        body: { caseMix: { simple: 3, negative: 1 }, varyUserStyles: true },
      });
      expect(res.status).toBe(200);
      expect(backend.sent()).toMatchObject({
        source: "generation",
        options: {
          caseMix: { simple: 3, negative: 1 },
          varyUserStyles: true,
        },
      });
    } finally {
      backend.restore();
    }
  });

  it("generate forwards mode:negative as the job's mode", async () => {
    // The plan is the job's to make now. What this layer must not do is drop
    // the caller's mode on the way there.
    const backend = authoringBackend();
    try {
      await generateWith({ body: { mode: "negative" } });
      expect(backend.sent()).toMatchObject({ options: { mode: "negative" } });
    } finally {
      backend.restore();
    }
  });


  // ── Wave-0 declared identity + the batch authoring surface ───────────────

  it("mints a declared id for a create that does not carry one", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "no id",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
    );
    expect(res.status).toBe(201);
    // This first-party surface mints rather than leaving the case identity-less.
    expect(isOpaqueId(authoredCaseArgs().caseId)).toBe(true);
  });

  it("forwards a caller-supplied id as the declared case id, unchanged", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        id: "c_from_suite_file",
        title: "declared",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        id: "not a valid id",
        title: "bad id",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases",
      ),
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        id: "c_taken",
        title: "dupe",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      { title: "bad", steps: [{ id: "s1", kind: "prompt", prompt: "hi" }] },
    );
    expect(res.status).toBe(400);
  });

  it("GET exposes the declared id alongside the platform id", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestCase"
        ? Promise.resolve({ ...CASE_DOC, declaredCaseId: "c_readback" })
        : defaultQueryImpl(name),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    const body = (await res.json()) as any;
    // Two DIFFERENT identities: the row id addresses the case in a URL, the
    // declared id is what the author committed to a suite file.
    expect(body.id).toBe("case1xxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(body.declaredId).toBe("c_readback");
  });

  it("omits declaredId for a case authored before declared identity existed", async () => {
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    const body = (await res.json()) as any;
    expect(body).not.toHaveProperty("declaredId");
  });

  it("POST /cases/batch authors every case in ONE mutation", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          {
            id: "c_b",
            title: "b",
            steps: [{ id: "s1", kind: "prompt", prompt: "b" }],
          },
        ],
      },
    );
    expect(res.status).toBe(201);
    const batchCalls = convexMutationMock.mock.calls.filter(
      (c) => c[0] === "testSuites:createTestCases",
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
        id: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        declaredId: expect.any(String),
        title: "a",
        replayed: false,
      },
      {
        index: 1,
        id: "case2xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
                testCaseId: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
                caseId: "c_a",
                replayed: false,
              },
            ],
            failed: [
              {
                index: 1,
                title: "b",
                code: "DUPLICATE_CONTENT",
                message:
                  "This case has the same definition as case9xxxxxxxxxxxxxxxxxxxxxxxxxxx.",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          { title: "b", steps: [{ id: "s1", kind: "prompt", prompt: "b" }] },
        ],
      },
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
        message:
          "This case has the same definition as case9xxxxxxxxxxxxxxxxxxxxxxxxxxx.",
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
        duplicatePolicy: "blcok",
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
        duplicatePolicy: "create_anyway",
        overrideReason: "porting a fixture verbatim",
      },
    );
    expect(res.status).toBe(201);
    const args = convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:createTestCases",
    )![1];
    expect(args.duplicatePolicy).toBe("create_anyway");
    expect(args.overrideReason).toBe("porting a fixture verbatim");
  });

  it("POST /cases/batch keys each case by its declared id, else by position", async () => {
    const res = await makeApp().request(
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
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
      },
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
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "a", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(allAuthoredCaseArgs()[0].idempotencyKey).toBeUndefined();
  });

  it("POST /cases/batch refuses more than the cap in one call", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: Array.from({ length: MAX_CASES_PER_BATCH + 1 }, (_, i) => ({
          title: `case-${i}`,
          steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        })),
      },
    );
    expect(res.status).toBe(400);
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases",
      ),
    ).toBe(false);
  });

  it("POST /cases/batch refuses an empty cases array", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      { cases: [] },
    );
    expect(res.status).toBe(400);
  });

  it("POST /cases/batch names the offending entry when one has no steps", async () => {
    const res = await request(
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          { title: "ok", steps: [{ id: "s1", kind: "prompt", prompt: "a" }] },
          { title: "no steps" },
        ],
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("cases[1]");
    // Nothing is authored: a batch with an unusable entry is a mistake about
    // the whole request, caught before the first write.
    expect(
      convexMutationMock.mock.calls.some(
        (c) => c[0] === "testSuites:createTestCases",
      ),
    ).toBe(false);
  });

  /**
   * The per-case INTENT label, across every public write shape.
   *
   * Asserted at the TRANSPORT boundary — the exact Convex mutation argument —
   * rather than by "the request succeeded". A route that dropped the label
   * would still return 201/200 and look right, so the only thing that catches
   * it is reading what actually crossed each edge, including the omitted/null
   * PATCH distinction and validation-before-mutation guarantee.
   */
  describe("per-case intent", () => {
    const PROMPT_STEP = { id: "s1", kind: "prompt", prompt: "hi" };
    const CASES_PATH =
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases";
    const CASE_PATH = `${CASES_PATH}/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx`;

    it("forwards a valid intent on create", async () => {
      const res = await request("POST", CASES_PATH, {
        title: "Refund flow",
        steps: [PROMPT_STEP],
        intent: "refund",
      });

      expect(res.status).toBe(201);
      expect(authoredCaseArgs().intent).toBe("refund");
    });

    it("forwards a valid intent on PATCH", async () => {
      const res = await request("PATCH", CASE_PATH, { intent: "refund" });

      expect(res.status).toBe(200);
      expect(updateArgs().intent).toBe("refund");
    });

    it("omits intent on PATCH when the caller leaves it untouched", async () => {
      const res = await request("PATCH", CASE_PATH, { title: "Renamed" });

      expect(res.status).toBe(200);
      expect("intent" in updateArgs()).toBe(false);
    });

    it("forwards null on PATCH to clear intent", async () => {
      const res = await request("PATCH", CASE_PATH, { intent: null });

      expect(res.status).toBe(200);
      expect(updateArgs().intent).toBeNull();
    });

    it.each(["", "   ", "\n\t", "x".repeat(65)])(
      "rejects invalid intent %j on create before mutation",
      async (intent) => {
        const res = await request("POST", CASES_PATH, {
          title: "Invalid intent",
          steps: [PROMPT_STEP],
          intent,
        });

        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );

    it.each(["", "   ", "\n\t", "x".repeat(65)])(
      "rejects invalid intent %j on PATCH before mutation",
      async (intent) => {
        const res = await request("PATCH", CASE_PATH, { intent });

        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );

    it("surfaces a Convex mutation failure", async () => {
      convexMutationMock.mockImplementation((name: string, args?: any) =>
        name === "testSuites:updateTestCase"
          ? Promise.reject(new Error("convex down"))
          : defaultMutationImpl(name, args),
      );

      const res = await request("PATCH", CASE_PATH, { intent: "refund" });

      expect(res.status).toBe(500);
    });
  });

  /**
   * `kind` rides the same three-way protocol as `intent`. The point of these
   * is the silent-drop trap: a v1 body is non-strict on create, so a field
   * the route forgets to forward vanishes with a 201 — and the CLI's
   * `--file` sync would then claim a kind the case never got.
   */
  describe("per-case kind", () => {
    const PROMPT_STEP = { id: "s1", kind: "prompt", prompt: "hi" };
    const CASES_PATH =
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases";
    const CASE_PATH = `${CASES_PATH}/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx`;

    it("forwards a valid kind on create", async () => {
      const res = await request("POST", CASES_PATH, {
        title: "Refund flow",
        steps: [PROMPT_STEP],
        kind: "regression",
      });

      expect(res.status).toBe(201);
      expect(authoredCaseArgs().kind).toBe("regression");
    });

    it("forwards a valid kind on PATCH", async () => {
      const res = await request("PATCH", CASE_PATH, { kind: "capability" });

      expect(res.status).toBe(200);
      expect(updateArgs().kind).toBe("capability");
    });

    it("omits kind on PATCH when the caller leaves it untouched", async () => {
      const res = await request("PATCH", CASE_PATH, { title: "Renamed" });

      expect(res.status).toBe(200);
      expect("kind" in updateArgs()).toBe(false);
    });

    it("forwards null on PATCH to clear kind", async () => {
      const res = await request("PATCH", CASE_PATH, { kind: null });

      expect(res.status).toBe(200);
      expect(updateArgs().kind).toBeNull();
    });

    it.each(["", "smoke", "CAPABILITY"])(
      "rejects invalid kind %j on PATCH before mutation",
      async (kind) => {
        const res = await request("PATCH", CASE_PATH, { kind });

        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        { title: "t", steps: [PROMPT_STEP], import: CLAIM },
      );
      expect(res.status).toBe(201);
      expect(authoredCaseArgs().import).toEqual(CLAIM);
    });

    it("forwards each case's own claim on a batch create", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
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
        },
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        { import: CLAIM },
      );
      expect(set.status).toBe(200);
      expect(updateArgs().import).toEqual(CLAIM);

      convexMutationMock.mockClear();
      const cleared = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        { import: null },
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        { title: "Renamed" },
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { import?: unknown };
      expect(body.import).toEqual(CLAIM);
    });

    it("omits `import` entirely for a natively authored case", async () => {
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
          "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
          { title: "t", steps: [PROMPT_STEP], import: claim },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { code?: string; message?: string };
        expect(json.code).toBe("VALIDATION_ERROR");
        expect(json.message).toContain(key);
        // Approval is a per-run decision the platform derives from the
        // authenticated launcher. Stripping the field instead of refusing it
        // would let a caller believe it had been honoured.
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );

    it("refuses an approval field on PATCH too", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        { import: { status: "approximated", note: "ok", approvedBy: "u" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it('refuses "exact" with no note', async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        { title: "t", steps: [PROMPT_STEP], import: { status: "exact" } },
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
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        {
          title: "t",
          steps: [PROMPT_STEP],
          import: {
            status: "approximated",
            sourceCaseKey: "k".repeat(512),
            note: "n".repeat(2000),
          },
        },
      );
      expect(res.status).toBe(201);
      expect(authoredCaseArgs().import.sourceCaseKey).toHaveLength(512);
      expect(authoredCaseArgs().import.note).toHaveLength(2000);
    });

    it.each([
      [
        "sourceCaseKey",
        { status: "approximated", sourceCaseKey: "k".repeat(513) },
      ],
      ["note", { status: "approximated", note: "n".repeat(2001) }],
    ] as const)("refuses %s one character over its cap", async (_l, claim) => {
      const res = await request(
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        { title: "t", steps: [PROMPT_STEP], import: claim },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("refuses an unknown mapping status", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        {
          title: "t",
          steps: [PROMPT_STEP],
          import: { status: "approximate" },
        },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  /**
   * B9b — the v2 verdict policy, the revision precondition, and the group id.
   *
   * The settings sheet's policy rows write `verdictPolicyDefaults`, which the
   * PATCH did not accept: an agent could see a row it had no way to drive. The
   * three rules pinned here are the ones a caller gets wrong:
   *
   *   - an UPGRADE is explicit (both halves, or neither), because a v2 policy
   *     with a repetition count and no threshold is not a partial answer;
   *   - a MERGE preserves what the caller did not mention, including inside
   *     `validity`, because PATCH is merge semantics everywhere else here;
   *   - the two thresholds are ALTERNATIVES, never layers, and nothing on this
   *     path converts a percent into a fraction.
   */
  describe("verdict policy v2 on PATCH", () => {
    const V2_SUITE = {
      ...SUITE_DOC,
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: {
        repetitions: 5,
        passThreshold: 0.6,
        validity: { minCompletionRate: 0.7, maxEvaluatorErrorRate: 0.2 },
      },
      // A v2 suite carries no legacy percent; leaving one here would let a
      // handler that reads the wrong field keep passing.
      defaultPassCriteria: undefined,
    };

    function withSuite(doc: Record<string, unknown>) {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve(doc)
          : defaultQueryImpl(name),
      );
    }

    function suiteUpdateArgs(): any {
      return convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestSuite",
      )?.[1];
    }

    it("refuses a half upgrade on a legacy suite, writing nothing", async () => {
      for (const settings of [{ repetitions: 3 }, { passThreshold: 0.8 }]) {
        vi.clearAllMocks();
        convexQueryMock.mockImplementation((name: string) =>
          defaultQueryImpl(name),
        );
        const res = await request(
          "PATCH",
          "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
          { settings },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { code?: string; message?: string };
        expect(json.code).toBe("VALIDATION_ERROR");
        expect(json.message).toContain("repetitions");
        expect(json.message).toContain("passThreshold");
        expect(convexMutationMock).not.toHaveBeenCalled();
      }
    });

    it("upgrades a legacy suite when both halves are supplied", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          settings: {
            repetitions: 3,
            passThreshold: 0.8,
            validity: { minCompletionRate: 0.9 },
          },
        },
      );
      expect(res.status).toBe(200);
      const args = suiteUpdateArgs();
      expect(args.verdictPolicyVersion).toBe(2);
      expect(args.verdictPolicyDefaults).toEqual({
        repetitions: 3,
        // The FRACTION as sent. A handler that divided the legacy percent by
        // 100 anywhere on this path would land 0.008 here.
        passThreshold: 0.8,
        validity: { minCompletionRate: 0.9 },
      });
    });

    it("merges a partial edit over a v2 suite's stored defaults", async () => {
      withSuite(V2_SUITE);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { passThreshold: 0.95 } },
      );
      expect(res.status).toBe(200);
      const args = suiteUpdateArgs();
      // `repetitions` and BOTH validity ceilings survive an edit that
      // mentioned neither — the object is written wholesale, so a handler that
      // sent only the changed field would silently clear the rest.
      expect(args.verdictPolicyDefaults).toEqual({
        repetitions: 5,
        passThreshold: 0.95,
        validity: { minCompletionRate: 0.7, maxEvaluatorErrorRate: 0.2 },
      });
      expect(args.verdictPolicyVersion).toBeUndefined();
    });

    it("merges validity field-by-field rather than replacing it", async () => {
      withSuite(V2_SUITE);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { validity: { minCompletionRate: 0.99 } } },
      );
      expect(res.status).toBe(200);
      expect(suiteUpdateArgs().verdictPolicyDefaults.validity).toEqual({
        minCompletionRate: 0.99,
        maxEvaluatorErrorRate: 0.2,
      });
    });

    it("refuses minimumAccuracy beside a v2 field (400, no mutation)", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { minimumAccuracy: 80, passThreshold: 0.8 } },
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { code?: string; message?: string };
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("minimumAccuracy");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("names the policy on the detail, without synthesizing a fraction", async () => {
      const legacy = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const legacySettings = ((await legacy.json()) as any).settings;
      expect(legacySettings.policy).toBe("legacy");
      expect(legacySettings.minimumAccuracy).toBe(80);
      // A legacy percent is NOT a v2 fraction wearing a different name; a DTO
      // that reported 0.8 here would hand a caller a threshold the suite is
      // not graded against.
      expect(legacySettings.passThreshold).toBeUndefined();
      expect(legacySettings.verdictPolicyVersion).toBeUndefined();
      expect(legacySettings.verdictPolicyDefaults).toBeUndefined();

      withSuite(V2_SUITE);
      const v2 = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const v2Settings = ((await v2.json()) as any).settings;
      expect(v2Settings.policy).toBe("v2");
      expect(v2Settings.verdictPolicyVersion).toBe(2);
      expect(v2Settings.verdictPolicyDefaults.passThreshold).toBe(0.6);
      expect(v2Settings.minimumAccuracy).toBeNull();
    });

    it("refuses minimumAccuracy on a v2 suite, pointing at passThreshold", async () => {
      withSuite(V2_SUITE);
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { minimumAccuracy: 80 } },
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { code?: string; message?: string };
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("passThreshold");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  /**
   * B9b — the revision precondition and the one revision group per request.
   */
  describe("suite revisions on PATCH", () => {
    it("forwards expectedRevisionNumber on the first write only", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          name: "Renamed",
          expectedRevisionNumber: 7,
          hosts: [],
        },
      );
      expect(res.status).toBe(200);
      const writes = convexMutationMock.mock.calls.filter(
        (c) => c[0] === "testSuites:updateTestSuite",
      );
      expect(writes.length).toBeGreaterThanOrEqual(2);
      expect(writes[0][1].expectedRevisionNumber).toBe(7);
      // Re-sending it would compare against a number THIS request has already
      // advanced, refusing the caller's own edit halfway through.
      for (const later of writes.slice(1)) {
        expect(later[1].expectedRevisionNumber).toBeUndefined();
      }
    });

    it("checks the precondition even when no settings write carries it", async () => {
      // `{ environmentIds }` alone never calls updateTestSuite, the only
      // mutation that accepts expectedRevisionNumber — so the stale number
      // used to be dropped and the write went through with a 200.
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({ ...SUITE_DOC, revisionNumber: 5 })
          : defaultQueryImpl(name),
      );
      const stale = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
          expectedRevisionNumber: 3,
        },
      );
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as { code?: string; message?: string };
      expect(body.code).toBe("CONFLICT");
      expect(body.message).toContain("current revision 5");
      expect(convexMutationMock).not.toHaveBeenCalled();

      const current = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
          expectedRevisionNumber: 5,
        },
      );
      expect(current.status).toBe(200);
      expect(
        convexMutationMock.mock.calls.some(
          (c) => c[0] === "testSuites:setSuiteEnvironments",
        ),
      ).toBe(true);
    });

    it("rides the precondition on the hosts write when that is the first one", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { hosts: [], expectedRevisionNumber: 7 },
      );
      expect(res.status).toBe(200);
      const writes = convexMutationMock.mock.calls.filter(
        (c) => c[0] === "testSuites:updateTestSuite",
      );
      expect(writes.length).toBe(1);
      expect(writes[0][1].expectedRevisionNumber).toBe(7);
    });

    it("stamps one revision group across every write in the request", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          name: "Renamed",
          hosts: [],
          environmentIds: ["env1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        },
      );
      expect(res.status).toBe(200);
      const revisions = convexMutationMock.mock.calls
        .filter(
          (c) =>
            c[0] === "testSuites:updateTestSuite" ||
            c[0] === "testSuites:setSuiteEnvironments",
        )
        .map((c) => c[1].revision);
      expect(revisions.length).toBeGreaterThanOrEqual(3);
      for (const revision of revisions) {
        expect(revision.source).toBe("api");
        expect(typeof revision.groupId).toBe("string");
      }
      expect(new Set(revisions.map((r: any) => r.groupId)).size).toBe(1);
    });

    it("maps a stale precondition to 409 CONFLICT with the current number", async () => {
      convexMutationMock.mockImplementation((name: string, args?: any) => {
        if (name === "testSuites:updateTestSuite") {
          const error: Error & { data?: unknown } = new Error(
            "This suite changed since you loaded it.",
          );
          error.data = {
            code: "EVAL_SUITE_REVISION_CONFLICT",
            message: "This suite changed since you loaded it.",
            current: 9,
            expected: 7,
          };
          return Promise.reject(error);
        }
        return defaultMutationImpl(name, args);
      });
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { name: "Renamed", expectedRevisionNumber: 7 },
      );
      expect(res.status).toBe(409);
      const json = (await res.json()) as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      expect(json.code).toBe("CONFLICT");
      // The number is the actionable half: "reload and retry" is only advice
      // if the caller learns what to retry against.
      expect(json.message).toContain("9");
      expect(json.details?.currentRevisionNumber).toBe(9);
    });

    it("reports revisionNumber on the suite detail, null when unrecorded", async () => {
      const unset = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      expect(((await unset.json()) as any).revisionNumber).toBeNull();

      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({ ...SUITE_DOC, revisionNumber: 4 })
          : defaultQueryImpl(name),
      );
      const set = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      expect(((await set.json()) as any).revisionNumber).toBe(4);
    });
  });

  /**
   * S6 — the suite's judge criteria on the public PATCH.
   *
   * `null` clears; an empty list is refused, because a rubric that asks nothing
   * is not the absence of one — it still changes what the judge was asked, and
   * every verdict is hashed against it.
   */
  describe("judge rubric on PATCH", () => {
    it("preserves instructions-only rubrics and refuses overlong mixed rubrics before writing", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          settings: {
            judge: { rubric: { instructions: "  Verify the tool result  " } },
          },
        },
      );
      expect(res.status).toBe(200);
      expect(suiteUpdateArgs().judgeRubric).toEqual({
        instructions: "Verify the tool result",
      });
      convexMutationMock.mockClear();
      const invalid = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          settings: {
            judge: {
              rubric: {
                instructions: "x".repeat(2001),
                criteria: [{ id: "a", label: "A" }],
              },
            },
          },
        },
      );
      expect(invalid.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
    function suiteUpdateArgs(): any {
      return convexMutationMock.mock.calls.find(
        (c) => c[0] === "testSuites:updateTestSuite",
      )?.[1];
    }

    it("maps settings.judge.rubric onto the suite's judgeRubric", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        {
          settings: {
            judge: {
              rubric: {
                criteria: [
                  { id: "cites", label: "Cites a source", required: true },
                ],
              },
            },
          },
        },
      );
      expect(res.status).toBe(200);
      const args = suiteUpdateArgs();
      // The rubric is a SUITE field, not a judge-config one: it is hashed into
      // every verdict and editing it retires the suite's calibration.
      expect(args.judgeRubric).toEqual({
        criteria: [{ id: "cites", label: "Cites a source", required: true }],
      });
    });

    it("clears with null and refuses an empty list", async () => {
      const cleared = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { judge: { rubric: null } } },
      );
      expect(cleared.status).toBe(200);
      expect(suiteUpdateArgs()).toHaveProperty("judgeRubric", null);

      vi.clearAllMocks();
      convexQueryMock.mockImplementation((name: string) =>
        defaultQueryImpl(name),
      );
      const empty = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { settings: { judge: { rubric: { criteria: [] } } } },
      );
      expect(empty.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("refuses a malformed criterion before the write", async () => {
      for (const criteria of [
        [{ id: "not valid!", label: "x" }],
        [{ id: "ok", label: "" }],
        [
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ]
          .slice(0, 1)
          .concat([{ id: "b", label: "z".repeat(201) }]),
      ]) {
        vi.clearAllMocks();
        convexQueryMock.mockImplementation((name: string) =>
          defaultQueryImpl(name),
        );
        const res = await request(
          "PATCH",
          "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
          { settings: { judge: { rubric: { criteria } } } },
        );
        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      }
    });

    it("reports the rubric back on the suite detail, null when there is none", async () => {
      const none = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      expect(((await none.json()) as any).settings.judge.rubric).toBeNull();

      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              judgeRubric: {
                criteria: [
                  { id: "cites", label: "Cites a source", description: "d" },
                ],
              },
            })
          : defaultQueryImpl(name),
      );
      const some = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      expect(((await some.json()) as any).settings.judge.rubric).toEqual({
        criteria: [{ id: "cites", label: "Cites a source", description: "d" }],
      });
    });
  });

  /**
   * S5b — the suite's settings history, for agents.
   *
   * The app reads the same history through Convex, so this route exists for
   * the SDK, the CLI and MCP. Two things it must get right: the project scope
   * (the revision list is addressed by suite id alone, so without the guard a
   * caller could read another project's history by guessing one) and an
   * out-of-range page size, which is a refusal rather than a silent clamp — a
   * caller who asked for 500 and got 100 cannot tell a capped page from the
   * end of the history.
   */
  describe("suite revisions route", () => {
    const REVISION = {
      _id: "rev_1",
      revisionNumber: 7,
      source: "api",
      createdBy: "user_1",
      createdByName: "Ada",
      createdAt: 1750,
      note: "tightened the threshold",
      changedFields: ["defaultPassCriteria"],
      revisionGroupId: "group-1",
      configRevisionHashAfter: "hash",
      pinnedRunCount: 100,
      pinnedRunCountCapped: true,
      // Never projected: the list carries no configuration snapshots.
      beforeSnapshot: { name: "old" },
      afterSnapshot: { name: "new" },
    };

    function withRevisions(page: {
      page: unknown[];
      isDone: boolean;
      continueCursor: string;
    }) {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:listSuiteRevisions"
          ? Promise.resolve(page)
          : defaultQueryImpl(name),
      );
    }

    it("projects a revision without its snapshots", async () => {
      withRevisions({ page: [REVISION], isDone: true, continueCursor: "" });
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/revisions",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toEqual({
        id: "rev_1",
        revisionNumber: 7,
        source: "api",
        createdBy: "user_1",
        createdByName: "Ada",
        createdAt: 1750,
        note: "tightened the threshold",
        changedFields: ["defaultPassCriteria"],
        revisionGroupId: "group-1",
        pinnedRunCount: 100,
        // The flag is what stops a caller reading the cap as an exact count.
        pinnedRunCountCapped: true,
      });
      expect(body.nextCursor).toBeUndefined();
    });

    it("forwards the cursor and reports the next one", async () => {
      withRevisions({
        page: [REVISION],
        isDone: false,
        continueCursor: "cursor-2",
      });
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/revisions?limit=5&cursor=cursor-1",
      );
      expect(res.status).toBe(200);
      const call = convexQueryMock.mock.calls.find(
        (c) => c[0] === "testSuites:listSuiteRevisions",
      );
      expect(call![1]).toEqual({
        suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        paginationOpts: { numItems: 5, cursor: "cursor-1" },
      });
      expect(((await res.json()) as any).nextCursor).toBe("cursor-2");
    });

    it("refuses an out-of-range limit rather than clamping it", async () => {
      for (const limit of ["0", "101", "abc"]) {
        vi.clearAllMocks();
        convexQueryMock.mockImplementation((name: string) =>
          defaultQueryImpl(name),
        );
        const res = await request(
          "GET",
          `/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/revisions?limit=${limit}`,
        );
        expect(res.status, limit).toBe(400);
      }
    });

    it("treats an empty limit as unsupplied", async () => {
      withRevisions({ page: [], isDone: true, continueCursor: "" });
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/revisions?limit=&cursor=",
      );
      // `?limit=` would otherwise coerce to 0 and be refused for a request
      // that asked for nothing in particular.
      expect(res.status).toBe(200);
      const call = convexQueryMock.mock.calls.find(
        (c) => c[0] === "testSuites:listSuiteRevisions",
      );
      expect(call![1].paginationOpts).toEqual({ numItems: 25, cursor: null });
    });

    it("404s for a suite in another project, without listing anything", async () => {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx",
            })
          : defaultQueryImpl(name),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/revisions",
      );
      expect(res.status).toBe(404);
      expect(
        convexQueryMock.mock.calls.find(
          (c) => c[0] === "testSuites:listSuiteRevisions",
        ),
      ).toBeUndefined();
    });
  });

  /**
   * B9b — the schedule reports a STATE, not just a boolean.
   */
  describe("schedule state on the suite detail", () => {
    it("reports state, owner, next due and failure count", async () => {
      convexQueryMock.mockImplementation((name: string) =>
        name === "testSuites:getTestSuite"
          ? Promise.resolve({
              ...SUITE_DOC,
              schedule: {
                enabled: true,
                intervalMinutes: 60,
                state: "paused_auth",
                createdByUserId: "user_9",
                consecutiveFailures: 3,
              },
              scheduleNextDueAt: 1750,
            })
          : defaultQueryImpl(name),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const schedule = ((await res.json()) as any).schedule;
      // `enabled` stays TRUE on a self-paused schedule, which is exactly why
      // reading it alone reports a healthy automation that has not run.
      expect(schedule.enabled).toBe(true);
      expect(schedule.state).toBe("paused_auth");
      expect(schedule.createdBy).toBe("user_9");
      expect(schedule.nextDueAt).toBe(1750);
      expect(schedule.consecutiveFailures).toBe(3);
    });

    it("reports a null state and a zero failure count when unset", async () => {
      const res = await request(
        "GET",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
      const schedule = ((await res.json()) as any).schedule;
      expect(schedule.state).toBeNull();
      expect(schedule.createdBy).toBeNull();
      expect(schedule.nextDueAt).toBeNull();
      expect(schedule.consecutiveFailures).toBe(0);
    });
  });

  describe("strict write bodies", () => {
    const PROMPT_STEP = { id: "s1", kind: "prompt", prompt: "hi" };

    it.each([
      [
        "PATCH /eval-suites/:suiteId",
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { name: "Renamed", hostz: [] },
        "hostz",
      ],
      [
        "PATCH /eval-suites/:suiteId/schedule",
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
        { enabled: false, interval: 60 },
        "interval",
      ],
      [
        "POST /cases",
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
        { title: "t", steps: [PROMPT_STEP], kind: "prompt" },
        "kind",
      ],
      [
        "POST /cases/batch",
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
        {
          cases: [{ title: "t", steps: [PROMPT_STEP] }],
          dryRun: true,
        },
        "dryRun",
      ],
      [
        "PATCH /cases/:caseId",
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
        { title: "n", query: "old field" },
        "query",
      ],
      [
        "POST /cases/generate",
        "POST",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/generate",
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
      },
    );

    it("names the field path on a typed-wrong declared key", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
        { name: 12 },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toMatch(/^name:/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * The CI-owned suite lock, as an API caller experiences it.
 *
 * The platform decides — there is no route-level ownership check, deliberately:
 * a second copy of the rule here is a copy that can disagree with the one that
 * actually guards the write. What these routes owe the caller is (a) a way to
 * write AS the file, and (b) a refusal they can act on instead of a 500.
 *
 * 409, not 403. The caller's ROLE is fine and no amount of privilege changes
 * the answer; what changes it is editing the source of truth or taking a copy.
 * A 403 would send someone to ask an admin for access they already have.
 */
describe("v1 eval-edit — CI-owned suites", () => {
  const CI_SUITE = { ...SUITE_DOC, declaredSuiteId: "s_from_file" };

  /** The platform's refusal, as it reaches the route. */
  function ciOwnedRefusal() {
    return Object.assign(new Error("ci owned"), {
      data: {
        code: "CI_OWNED_SUITE_READ_ONLY",
        action: "suite.edit",
        message:
          "This suite is managed by CI. Edit the test file in your repository " +
          "and run it again, or duplicate the suite to get an editable copy.",
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") return Promise.resolve(CI_SUITE);
      return defaultQueryImpl(name);
    });
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      // The platform allows the write iff the marker names the suite's own id.
      const declared = args?.fileSync?.declaredSuiteId;
      if (declared !== "s_from_file") throw ciOwnedRefusal();
      return defaultMutationImpl(name, args);
    });
  });

  it.each([
    [
      "PATCH suite",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { name: "renamed" },
    ],
    [
      "PATCH schedule",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      { enabled: true, intervalMinutes: 60 },
    ],
    [
      "POST case",
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "added",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
    ],
    [
      "PATCH case",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { title: "renamed" },
    ],
  ] as const)(
    "refuses %s without the marker, as a 409 naming the remedy",
    async (_label, method, path, body) => {
      const res = await request(method, path, { ...body });
      expect(res.status).toBe(409);
      const json = (await res.json()) as {
        code?: string;
        message?: string;
        details?: { reason?: string; hint?: string };
      };
      expect(json.code).toBe("CONFLICT");
      expect(json.details?.reason).toBe("CI_OWNED_SUITE_READ_ONLY");
      // The platform's own copy survives the trip — it names the two remedies
      // an app user has.
      expect(json.message).toMatch(/duplicate/i);
      // …and the hint names the third one, which only an API caller has.
      expect(json.details?.hint).toContain("declaredSuiteId");
    },
  );

  it.each([
    [
      "PATCH suite",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { name: "renamed", declaredSuiteId: "s_from_file" },
      "testSuites:updateTestSuite",
    ],
    [
      "PATCH schedule",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      {
        enabled: true,
        intervalMinutes: 60,
        declaredSuiteId: "s_from_file",
      },
      "testSuites:setSuiteSchedule",
    ],
    [
      "POST case",
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      {
        title: "added",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        declaredSuiteId: "s_from_file",
      },
      "testSuites:createTestCases",
    ],
    [
      "PATCH case",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { title: "renamed", declaredSuiteId: "s_from_file" },
      "testSuites:updateTestCase",
    ],
  ] as const)(
    "forwards the marker on %s, and the write lands",
    async (_label, method, path, body, mutation) => {
      const res = await request(method, path, { ...body });
      expect(res.status).toBeLessThan(300);
      const call = convexMutationMock.mock.calls.find(
        ([name]: [string]) => name === mutation,
      );
      expect(call?.[1]).toMatchObject({
        fileSync: { declaredSuiteId: "s_from_file" },
      });
    },
  );

  it.each([
    [
      "PATCH suite",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      { name: "renamed" },
      "testSuites:updateTestSuite",
    ],
    [
      "PATCH schedule",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/schedule",
      { enabled: true, intervalMinutes: 60 },
      "testSuites:setSuiteSchedule",
    ],
    [
      "POST case",
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases",
      { title: "added", steps: [{ id: "s1", kind: "prompt", prompt: "hi" }] },
      "testSuites:createTestCases",
    ],
    [
      "POST case batch",
      "POST",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/batch",
      {
        cases: [
          {
            title: "added",
            steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
          },
        ],
      },
      "testSuites:createTestCases",
    ],
    [
      "PATCH case",
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      { title: "renamed" },
      "testSuites:updateTestCase",
    ],
  ] as const)(
    "takes the marker from the QUERY STRING on %s — the spelling the SDK sends",
    async (_label, method, path, body, mutation) => {
      // The wire contract that matters. Every body here is `.strict()`, on this
      // Inspector and on every Inspector that predates the lock, so a body
      // field is a 400 against an older deployment — which would break
      // `eval run --file` for anyone whose CLI is newer than their Inspector.
      // The SDK therefore puts it on the query string, and this is the half
      // that has to read it.
      const res = await request(method, `${path}?declaredSuiteId=s_from_file`, {
        ...body,
      });
      expect(res.status).toBeLessThan(300);
      const call = convexMutationMock.mock.calls.find(
        ([name]: [string]) => name === mutation,
      );
      expect(call?.[1]).toMatchObject({
        fileSync: { declaredSuiteId: "s_from_file" },
      });
    },
  );

  it("takes the marker as a query parameter on the deletes", async () => {
    const suite = await request(
      "DELETE",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx?declaredSuiteId=s_from_file",
    );
    expect(suite.status).toBe(200);
    expect(
      convexMutationMock.mock.calls.find(
        ([name]: [string]) => name === "testSuites:deleteTestSuite",
      )?.[1],
    ).toMatchObject({ fileSync: { declaredSuiteId: "s_from_file" } });

    convexMutationMock.mockClear();
    const testCase = await request(
      "DELETE",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx/cases/case1xxxxxxxxxxxxxxxxxxxxxxxxxxx?declaredSuiteId=s_from_file",
    );
    expect(testCase.status).toBe(200);
    expect(
      convexMutationMock.mock.calls.find(
        ([name]: [string]) => name === "testSuites:deleteTestCase",
      )?.[1],
    ).toMatchObject({ fileSync: { declaredSuiteId: "s_from_file" } });
  });

  it("sends NO fileSync at all when the caller did not name an id", async () => {
    // An older platform rejects an unknown mutation argument outright, so
    // `fileSync: undefined` would break every ordinary suite edit against a
    // deployment that predates the lock.
    convexMutationMock.mockImplementation((name: string, args?: any) =>
      defaultMutationImpl(name, args),
    );
    await request(
      "PATCH",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
      {
        name: "renamed",
      },
    );
    const call = convexMutationMock.mock.calls.find(
      ([name]: [string]) => name === "testSuites:updateTestSuite",
    );
    expect(call?.[1]).not.toHaveProperty("fileSync");
  });

  it("reports the suite as CI-managed before anyone tries to write it", async () => {
    convexMutationMock.mockImplementation((name: string, args?: any) =>
      defaultMutationImpl(name, args),
    );
    const res = await request(
      "GET",
      "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { managedBy?: string };
    // Without this the first sign that a suite is read-only was a 409 on a
    // write the caller had no way to know would be refused.
    expect(body.managedBy).toBe("ci");
  });
});

// =============================================================================
// `x-mcpjam-eval-vocabulary` — the negotiation header.
//
// Absent means vocabulary 1, which is byte-for-byte today's contract. The
// header is not decoration: a published `mcpjam cloud eval gate` finds the
// scorers that decide a run by filtering definition roles on the literal
// `"gating"`, so an unannounced `required` in a response would empty its
// gating set and let a failing run pass — silently, in exactly the workflow a
// gate exists to serve.
// =============================================================================

describe("eval vocabulary negotiation", () => {
  const SUITE_PATH =
    "/api/v1/projects/proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx/eval-suites/suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";

  const updateArgs = () =>
    convexMutationMock.mock.calls.find(
      (c) => c[0] === "testSuites:updateTestSuite",
    )![1];

  it("refuses a value it does not speak, naming both it does", async () => {
    const res = await request("GET", SUITE_PATH, undefined, "tok", {
      "x-mcpjam-eval-vocabulary": "3",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("x-mcpjam-eval-vocabulary");
  });

  it("sets Vary on the REFUSAL too, not only on the success path", async () => {
    // A cache holding an un-Vary'd 400 replays it to the next caller on that
    // URL — including one who sent a header this deployment accepts. An error
    // response is the one you least want served to somebody else's request.
    const res = await request("GET", SUITE_PATH, undefined, "tok", {
      "x-mcpjam-eval-vocabulary": "3",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Vary") ?? "").toContain("x-mcpjam-eval-vocabulary");
  });

  it("refuses an explicitly EMPTY header rather than defaulting it", async () => {
    // Only an ABSENT header means vocabulary 1. Accepting blank would make it
    // a third, undocumented spelling of "1", so a client whose header came out
    // empty by accident would silently get the legacy projection instead of
    // the validation error this negotiation exists to give it.
    const res = await request("GET", SUITE_PATH, undefined, "tok", {
      "x-mcpjam-eval-vocabulary": "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("x-mcpjam-eval-vocabulary");
  });

  it("still defaults an ABSENT header to vocabulary 1", async () => {
    const res = await request("GET", SUITE_PATH);
    expect(res.status).toBe(200);
  });

  it("sets Vary so a cache cannot serve one client another's spelling", async () => {
    const res = await request("GET", SUITE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Vary") ?? "").toContain("x-mcpjam-eval-vocabulary");
  });

  it("refuses a canonical role under vocabulary 1 — today's contract is not widened", async () => {
    const res = await request("PATCH", SUITE_PATH, {
      settings: { checks: [{ type: "noToolErrors", role: "required" }] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("x-mcpjam-eval-vocabulary: 2");
  });

  it("accepts it under vocabulary 2, and stores the form Gate always had", async () => {
    const res = await requestV2("PATCH", SUITE_PATH, {
      settings: { checks: [{ type: "noToolErrors", role: "required" }] },
    });
    expect(res.status).toBe(200);
    // The ABSENT field, not `"gating"`: that is a predicate's required form,
    // so the suite's configuration revision does not move for a spelling.
    expect(updateArgs().defaultPredicates).toEqual([{ type: "noToolErrors" }]);
  });

  it("leaves an advisory check untouched under either vocabulary", async () => {
    for (const send of [request, requestV2]) {
      convexMutationMock.mockClear();
      const res = await send("PATCH", SUITE_PATH, {
        settings: {
          checks: [
            { type: "noToolErrors", role: "advisory", severity: "warn" },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(updateArgs().defaultPredicates).toEqual([
        { type: "noToolErrors", role: "advisory", severity: "warn" },
      ]);
    }
  });

  it("forwards the judge role — the field the SDK sent and this route dropped", async () => {
    // `updateEvalSuiteInput.settings.judge.role` has been in the SDK's request
    // type since the judge gate shipped, and the PATCH schema had no `role`
    // key, so zod stripped it. Authoring a judge role over the API, over MCP
    // or from the CLI did nothing at all, and no test covered it.
    const res = await request("PATCH", SUITE_PATH, {
      settings: { judge: { role: "gating" } },
    });
    expect(res.status).toBe(200);
    expect(updateArgs().judgeConfig.goalCompletion.role).toBe("gating");
  });

  it("normalizes a canonical judge role to the stored spelling under vocabulary 2", async () => {
    // A judge's required form IS a present value, unlike a check's, so this
    // one maps to `gating` rather than being stripped.
    const res = await requestV2("PATCH", SUITE_PATH, {
      settings: { judge: { role: "required" } },
    });
    expect(res.status).toBe(200);
    expect(updateArgs().judgeConfig.goalCompletion.role).toBe("gating");
  });

  it("refuses a canonical judge role under vocabulary 1", async () => {
    const res = await request("PATCH", SUITE_PATH, {
      settings: { judge: { role: "required" } },
    });
    expect(res.status).toBe(400);
  });
});


describe("authoring job ID validation", () => {
  it.each(["GET", "POST"])("rejects malformed IDs on %s before querying Convex", async (method) => {
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockClear();
    const response = await request(method, `/api/v1/projects/p1/eval-suites/s1/authoring/not-an-id${method === "POST" ? "/commit" : ""}`);
    expect(response.status).toBe(404);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});
