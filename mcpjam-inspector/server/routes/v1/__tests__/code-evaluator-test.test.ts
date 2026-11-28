import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName, type FunctionReference } from "convex/server";

// "Test on a past iteration" (EFTW-90, I5) through the route, with the real
// test service: only the backend, Convex and E2B are stood in for.

const mocks = vi.hoisted(() => ({
  setAuth: vi.fn(),
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
  provision: vi.fn(),
  attach: vi.fn(),
  release: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth(token: string) {
      mocks.setAuth(token);
    }
    query(ref: FunctionReference<"query">, args: unknown) {
      return mocks.query(getFunctionName(ref), args);
    }
    action(ref: FunctionReference<"action">, args: unknown) {
      return mocks.action(getFunctionName(ref), args);
    }
    mutation(ref: FunctionReference<"mutation">, args: unknown) {
      return mocks.mutation(getFunctionName(ref), args);
    }
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "member-token",
}));
vi.mock("../../../utils/computers/code-evaluator-preview-client.js", () => ({
  provisionCodeEvaluatorPreview: mocks.provision,
}));
vi.mock("../../../utils/computers/attach-sandbox.js", () => ({
  attachRunningSandbox: mocks.attach,
}));
vi.mock(
  "../../../utils/computers/control-plane-client.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../utils/computers/control-plane-client.js")
    >()),
    releaseSandbox: mocks.release,
  }),
);

import router from "../code-evaluator-test.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const app = new Hono().route("/api/v1", router);
app.onError(v1OnError);

const PROJECT = "project";
const SUITE = "k17abcdefghijklmnopqrstuvwxyz0123";
const ITERATION = "k27abcdefghijklmnopqrstuvwxyz0123";
const url = (suite = SUITE) =>
  `/api/v1/projects/${PROJECT}/eval-suites/${suite}/code-evaluators/test`;
const body = {
  iterationId: ITERATION,
  evaluator: { fileName: "check.sh", script: "echo ok" },
};
const post = (payload: unknown = body, suite = SUITE) =>
  app.request(url(suite), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

/** A box whose draft writes `result` to `$MCPJAM_RESULT`. */
function box(result: string) {
  const files = new Map<string, string>();
  return {
    files,
    sandbox: {
      files: {
        write: vi.fn(async (path: string, data: string) => {
          files.set(path, data);
          return {};
        }),
        read: vi.fn(async (path: string) => {
          const data = files.get(path);
          if (data === undefined) throw new Error("not found");
          return data;
        }),
      },
      commands: {
        run: vi.fn(async (cmd: string, opts: { background?: boolean }) => {
          if (!opts.background) return { exitCode: 0 };
          const resultPath = /MCPJAM_RESULT=([^']+)'/.exec(cmd)?.[1];
          if (resultPath) files.set(resultPath, result);
          return {
            kill: async () => true,
            wait: async () => ({ exitCode: 0 }),
          };
        }),
      },
    },
  };
}

const iteration = {
  _id: ITERATION,
  suiteRunId: "run",
  testCaseSnapshot: {
    title: "Totals add up",
    expectedToolCalls: [{ toolName: "sum", arguments: { ids: [1] } }],
    expectedOutput: "3",
  },
  actualToolCalls: [{ toolName: "sum", arguments: { ids: [1] } }],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.query.mockImplementation(async (name: string) => {
    if (name === "testSuites:getTestSuite") return { projectId: PROJECT };
    if (name === "testSuites:getTestIteration") return iteration;
    throw new Error(`unexpected query ${name}`);
  });
  mocks.action.mockImplementation(async (name: string) => {
    if (name === "testSuites:getTestIterationBlob") {
      return { messages: [{ role: "assistant", content: "The total is 3." }] };
    }
    throw new Error(`unexpected action ${name}`);
  });
  mocks.provision.mockResolvedValue({
    ok: true,
    value: {
      sandboxId: "sbx",
      sandboxRowId: "row",
      runId: "run",
      network: "none",
    },
  });
  mocks.release.mockResolvedValue(undefined);
});

describe("POST /code-evaluators/test", () => {
  it("tests the draft on the rebuilt iteration and writes nothing", async () => {
    const scripted = box('{"score": 1, "reason": "total matches"}');
    mocks.attach.mockResolvedValue(scripted.sandbox);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: "run",
      iterationId: ITERATION,
      input: "transcript",
      network: "none",
      result: {
        status: "scored",
        score: 1,
        threshold: 1,
        passed: true,
        reason: "total matches",
      },
      logs: { output: "", exitCode: 0, durationMs: expect.any(Number) },
    });
    // As the member, on the suite the path names.
    expect(mocks.setAuth).toHaveBeenCalledWith("member-token");
    expect(mocks.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "member-token",
        suiteId: SUITE,
        iterationId: ITERATION,
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith("testSuites:getTestIteration", {
      iterationId: ITERATION,
    });
    expect(mocks.action).toHaveBeenCalledWith(
      "testSuites:getTestIterationBlob",
      { iterationId: ITERATION },
    );
    const input = JSON.parse(scripted.files.get("/mcpjam/iteration.json")!);
    expect(input).toMatchObject({
      scenario: { title: "Totals add up" },
      expectedOutput: "3",
      expectedToolCalls: [{ toolName: "sum", arguments: { ids: [1] } }],
      transcript: { finalAssistantMessage: "The total is 3." },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row" }),
    );
  });

  it("refuses a suite from another project before booting anything", async () => {
    mocks.query.mockResolvedValue({ projectId: "someone-else" });
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("is closed to guests at the v1 boundary", () => {
    expect(isGuestAllowedV1Request("POST", url())).toBe(false);
  });

  it.each([
    ["not JSON", "{"],
    [
      "a bad file name",
      { ...body, evaluator: { fileName: "a.rb", script: "x" } },
    ],
    [
      "an empty script",
      { ...body, evaluator: { fileName: "a.sh", script: " " } },
    ],
    [
      "a threshold out of range",
      { ...body, evaluator: { fileName: "a.sh", script: "x", threshold: 2 } },
    ],
    [
      "a bad id",
      { ...body, evaluator: { fileName: "a.sh", script: "x", id: "a b" } },
    ],
    [
      "a script over 64 KB",
      { ...body, evaluator: { fileName: "a.sh", script: "x".repeat(65_537) } },
    ],
    ["an unknown network", { ...body, network: "all" }],
  ])("refuses %s before booting anything", async (_name, payload) => {
    const response = await post(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("answers a malformed suite or iteration id as not found", async () => {
    expect((await post(body, "nope")).status).toBe(404);
    expect((await post({ ...body, iterationId: "nope" })).status).toBe(404);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it.each([
    [401, undefined, "Missing or invalid bearer token", 401, "UNAUTHORIZED"],
    [403, undefined, "Sign in to test a code evaluator.", 403, "FORBIDDEN"],
    [
      403,
      "FEATURE_UNAVAILABLE",
      "Code evaluators are not available for this organization.",
      403,
      "FORBIDDEN",
    ],
    [404, "NOT_FOUND", "Iteration not found", 404, "NOT_FOUND"],
    [
      409,
      "EVAL_RUN_NOT_TERMINAL",
      "This run is still in progress. Test the code evaluator on an iteration from a finished run.",
      409,
      "CONFLICT",
    ],
    [
      429,
      "EVAL_CODE_EVALUATOR_PREVIEW_COOLDOWN",
      "You just tested an evaluator on this iteration. Wait a few seconds, then try again.",
      429,
      "RATE_LIMITED",
    ],
    [
      400,
      "image_unavailable",
      "The run's image is gone.",
      400,
      "VALIDATION_ERROR",
    ],
  ])(
    "maps a %i %s refusal, keeping the backend's words",
    async (status, code, error, httpStatus, v1Code) => {
      mocks.provision.mockResolvedValue({
        ok: false,
        status,
        error,
        ...(code ? { code } : {}),
      });
      const response = await post();
      expect(response.status).toBe(httpStatus);
      expect(await response.json()).toEqual({
        code: v1Code,
        message: error,
        ...(code ? { details: { code } } : {}),
      });
      expect(mocks.attach).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
    },
  );

  it("answers a full pool as a rate limit, with the backend's Retry-After", async () => {
    mocks.provision.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Computers is at capacity",
      code: "at_capacity",
      retryAfterMs: 30_000,
    });
    const response = await post();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Computers is at capacity",
    });
  });

  it("reports an unreachable backend as an internal error", async () => {
    mocks.provision.mockResolvedValue({
      ok: false,
      status: 0,
      error: "network error",
    });
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("releases the box when the stored iteration can't be read", async () => {
    mocks.attach.mockResolvedValue(box('{"score": 1}').sandbox);
    mocks.action.mockRejectedValue(new Error("fetch failed"));
    const response = await post();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row" }),
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
