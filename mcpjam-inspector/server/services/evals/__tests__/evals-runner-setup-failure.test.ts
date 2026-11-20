/**
 * An iteration whose setup fails (`prepareChatV2`) is written `setup_failed` either
 * way; only a failure MCPJam owns reaches Sentry through `logger.error`. A
 * refusal from the user's MCP server fails every iteration of the run, and
 * paging once per iteration on it was INSPECTOR-HONO-39.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

vi.mock("../../../utils/chat-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return { ...actual, createLlmModel: () => ({ id: "mock-model" }) };
});

vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

const prepareChatV2Mock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
}));

const assistantTurnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => assistantTurnMock(...args),
}));

// Off by default: no box is booked and setup goes straight to prepareChatV2.
const sandbox = vi.hoisted(() => ({ needed: false }));
vi.mock("../needs-ephemeral-sandbox", async () => {
  const actual = await vi.importActual<
    typeof import("../needs-ephemeral-sandbox")
  >("../needs-ephemeral-sandbox");
  return {
    ...actual,
    needsEphemeralEvalSandbox: (
      ...args: Parameters<typeof actual.needsEphemeralEvalSandbox>
    ) =>
      sandbox.needed
        ? { needed: true, runtimeKind: "terminal" }
        : actual.needsEphemeralEvalSandbox(...args),
  };
});

const acquireHarnessBoxMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/harness/harness-box.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-box.js")
  >("../../../utils/harness/harness-box.js");
  return {
    ...actual,
    harnessBoxUnavailableReason: () => null,
    acquireHarnessBox: (...args: unknown[]) => acquireHarnessBoxMock(...args),
  };
});

import {
  defaultEvalExecutionBudgets,
  runEvalSuiteWithAiSdk,
} from "../../evals-runner.js";
import { logger } from "../../../utils/logger";

const SETUP_FAILED = "[evals] iteration setup failed (prepareChatV2)";

async function runFailingSetup(error: unknown, runs = 2) {
  prepareChatV2Mock.mockRejectedValue(error);
  const rows = Array.from({ length: runs }, (_, index) => ({
    _id: `iter-${index + 1}`,
    testCaseId: "case-1",
    iterationNumber: index + 1,
    status: "pending",
    result: "pending",
  })) as Array<Record<string, any>>;
  const recorder = {
    startIteration: vi.fn(
      async ({ iterationNumber }: { iterationNumber: number }) =>
        rows[iterationNumber - 1]!._id,
    ),
    beginExecutionAttempt: vi.fn(async () => {}),
    finishIteration: vi.fn(async (args: Record<string, any>) =>
      Object.assign(
        rows.find((row) => row._id === args.iterationId)!,
        args,
      ),
    ),
    finalize: vi.fn(async () => {}),
  };
  await runEvalSuiteWithAiSdk({
    suiteId: "suite-1",
    runId: "run-1",
    recorder,
    config: {
      tests: [
        {
          title: "Case",
          query: "Hello",
          model: "gpt-5-mini",
          provider: "openai",
          runs,
          testCaseId: "case-1",
          expectedToolCalls: [],
          promptTurns: [
            { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
          ],
        },
      ],
      environment: { servers: ["srv-1"] },
    },
    modelApiKeys: { openai: "sk-test" },
    convexClient: {
      query: vi.fn(async () => ({ status: "running" })),
      mutation: vi.fn(async () => ({})),
      action: vi.fn(async () => undefined),
    },
    convexHttpUrl: "https://example.convex.site",
    convexAuthToken: "token",
    mcpClientManager: {
      getToolsForAiSdk: vi.fn(async () => ({})),
      listTools: vi.fn(async () => ({ tools: [] })),
      getAllToolAnnotations: vi.fn(() => ({})),
      hasCachedToolAnnotations: vi.fn(() => true),
      getConnectionStatus: vi.fn(() => "connected"),
      listServers: vi.fn(() => ["srv-1"]),
      getAllToolsMetadata: vi.fn(() => ({})),
      executeTool: vi.fn(),
    },
    executionBudgets: defaultEvalExecutionBudgets(),
  } as any);
  return rows;
}

let loggerError: MockInstance<typeof logger.error>;
let loggerWarn: MockInstance<typeof logger.warn>;

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  prepareChatV2Mock.mockReset();
  assistantTurnMock.mockReset();
  acquireHarnessBoxMock.mockReset();
  sandbox.needed = false;
  loggerError = vi.spyOn(logger, "error");
  loggerWarn = vi.spyOn(logger, "warn");
});

afterEach(() => {
  loggerError.mockRestore();
  loggerWarn.mockRestore();
  vi.unstubAllEnvs();
});

const setupErrorCalls = (
  spy: MockInstance<typeof logger.error | typeof logger.warn>,
) => spy.mock.calls.filter(([message]) => message === SETUP_FAILED);

describe("iteration setup failure (prepareChatV2)", () => {
  it.each([
    [
      "an HTTP error from the user's server",
      new SdkHttpError(
        SdkErrorCode.ClientHttpNotImplemented,
        "Error POSTing to endpoint: Not Found",
        { status: 404, statusText: "Not Found" },
      ),
      "server/http_error",
    ],
    ["a 401 from the user's server", new UnauthorizedError(), "auth/http_401"],
  ])("warns, without paging, on %s", async (_label, error, slug) => {
    const rows = await runFailingSetup(error);

    expect(rows.map((row) => row.status)).toEqual([
      "setup_failed",
      "setup_failed",
    ]);
    expect(setupErrorCalls(loggerError)).toEqual([]);
    expect(setupErrorCalls(loggerWarn)).toEqual([
      [SETUP_FAILED, { slug }],
      [SETUP_FAILED, { slug }],
    ]);
  });

  it("still pages on a failure no catalog entry puts on the user", async () => {
    const error = new SdkError(SdkErrorCode.NotConnected, "Not connected");
    const rows = await runFailingSetup(error);

    expect(rows.map((row) => row.status)).toEqual([
      "setup_failed",
      "setup_failed",
    ]);
    expect(setupErrorCalls(loggerWarn)).toEqual([]);
    expect(setupErrorCalls(loggerError)).toEqual([
      [SETUP_FAILED, error],
      [SETUP_FAILED, error],
    ]);
  });

  it("still pages when MCPJam's control plane refuses the connection", async () => {
    // ECONNREFUSED classifies as the user's configuration wherever it comes
    // from; here it is our own sandbox provisioning, before any user server.
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });
    sandbox.needed = true;
    acquireHarnessBoxMock.mockRejectedValue(error);
    const rows = await runFailingSetup(new Error("unreached"));

    expect(prepareChatV2Mock).not.toHaveBeenCalled();
    expect(rows.map((row) => row.status)).toEqual([
      "setup_failed",
      "setup_failed",
    ]);
    expect(setupErrorCalls(loggerWarn)).toEqual([]);
    expect(setupErrorCalls(loggerError)).toEqual([
      [SETUP_FAILED, error],
      [SETUP_FAILED, error],
    ]);
  });
});
