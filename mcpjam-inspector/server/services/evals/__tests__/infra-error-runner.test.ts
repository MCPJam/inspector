/**
 * An infra failure travels from its TYPED producer to the written row.
 *
 * The engine (`runAssistantTurn`) is the only thing mocked: it fires the
 * `onEngineError` event the real producers emit — built here with the real
 * producer functions (the Claude Code bridge's wire object, Codex's
 * `codexErrorInfo` notification, the backend's envelope) — and everything
 * after it is real: the hosted turn driver, the step executor and its bridge,
 * the classifier, the finish params and the run summary. A row OUR
 * infrastructure failed is written `failed` + `infraError` and counted in no
 * rate; anything not provably ours, and every timeout, is written exactly as
 * before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

vi.mock("../../../utils/chat-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return { ...actual, createLlmModel: () => ({ id: "mock-model" }) };
});

vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: any) => ({
    allTools: {},
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    resolvedTemperature: options?.temperature,
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: {
      loadedToolIds: new Set<string>(),
      catalogVersion: 0,
    },
  })),
}));

const assistantTurnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => assistantTurnMock(...args),
}));

import {
  defaultEvalExecutionBudgets,
  runEvalSuiteWithAiSdk,
} from "../../evals-runner.js";
import type { MCPJamEngineErrorEvent } from "../../../utils/mcpjam-stream-handler";
import {
  codexProviderEvidenceFromNotification,
  harnessFailureEvidenceOf,
} from "../../../utils/harness/harness-provider-error";

type Turn = (opts: any) => Promise<unknown>;

/** The engine failed this turn: it reported `event` and produced nothing. */
function failingTurn(
  event: Omit<MCPJamEngineErrorEvent, "promptIndex" | "rawText">,
): Turn {
  return async (opts) => {
    opts.onEngineError?.({ rawText: event.message, promptIndex: 0, ...event });
    return { messages: opts.messages, turnTrace: { spans: [] } };
  };
}

/** The engine answered the turn. */
const answeringTurn: Turn = async (opts) => ({
  messages: [...opts.messages, { role: "assistant", content: "Done." }],
  turnTrace: { spans: [] },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

async function runHosted(
  turns: Turn[],
  budgets = defaultEvalExecutionBudgets(),
) {
  for (const turn of turns) assistantTurnMock.mockImplementationOnce(turn);
  return runSuite(turns.length, "gpt-5-mini", budgets);
}

async function runSuite(
  runs: number,
  model: string,
  budgets = defaultEvalExecutionBudgets(),
) {
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
  const convexClient = {
    query: vi.fn(async () => ({ status: "running" })),
    mutation: vi.fn(async () => ({})),
    action: vi.fn(async () => undefined),
  };
  const manager = {
    getToolsForAiSdk: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [] })),
    getAllToolAnnotations: vi.fn(() => ({})),
    hasCachedToolAnnotations: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected"),
    listServers: vi.fn(() => ["srv-1"]),
    getAllToolsMetadata: vi.fn(() => ({})),
    executeTool: vi.fn(),
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
          // `gpt-5-mini` is MCPJam-provided: the HOSTED runner, through
          // `/stream`. `gpt-4-turbo` runs LOCALLY on the caller's key.
          model,
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
    convexClient,
    convexHttpUrl: "https://example.convex.site",
    convexAuthToken: "token",
    mcpClientManager: manager,
    executionBudgets: budgets,
  } as any);
  return { rows, recorder };
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  assistantTurnMock.mockReset();
  streamTextMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted runner — a provider failure our backend categorized", () => {
  it("is written failed + infraError and left out of the run summary", async () => {
    const { rows, recorder } = await runHosted([
      failingTurn({
        message: "The AI provider is temporarily unavailable.",
        code: "provider_error",
        httpStatus: 503,
        phase: "stream",
        infra: {
          source: "backend_model",
          code: "provider_error",
          httpStatus: 503,
        },
      }),
      answeringTurn,
    ]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      passed: false,
      error: "The AI provider is temporarily unavailable.",
      infraError: {
        class: "provider_unavailable",
        layer: "model",
        retryable: true,
        code: "provider_error",
        httpStatus: 503,
      },
    });
    expect(rows[1]).toMatchObject({ status: "completed", passed: true });
    expect(rows[1]).not.toHaveProperty("infraError");
    // One measured trial, and it passed: the outage is in no count.
    expect(recorder.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ total: 1, passed: 1, failed: 0 }),
      }),
    );
  });

  it("an uncategorized backend 500 (`unknown_error`) is still a measured failure", async () => {
    const { rows, recorder } = await runHosted([
      failingTurn({
        message: "Cannot read properties of undefined",
        code: "unknown_error",
        httpStatus: 500,
        phase: "stream",
        infra: { source: "backend_model", code: "unknown_error" },
      }),
    ]);
    expect(rows[0]).toMatchObject({ status: "completed", passed: false });
    expect(rows[0]).not.toHaveProperty("infraError");
    expect(recorder.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ total: 1, failed: 1 }),
      }),
    );
  });

  it("the same 503 from the customer's server (no typed evidence) is a measured failure", async () => {
    const { rows } = await runHosted([
      failingTurn({
        message: "MCP error -32603: upstream returned 503 Service Unavailable",
        httpStatus: 503,
        phase: "stream",
      }),
    ]);
    expect(rows[0]).toMatchObject({ status: "completed", passed: false });
    expect(rows[0]).not.toHaveProperty("infraError");
  });

  it("agent_turn_limit is an excluded account limit", async () => {
    const { rows } = await runHosted([
      failingTurn({
        message: "Too many Ask MCPJam turns in a row. Retry in a moment.",
        code: "agent_turn_limit",
        httpStatus: 429,
        phase: "stream",
        infra: { source: "backend_model", code: "agent_turn_limit" },
      }),
    ]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      infraError: {
        class: "account_limit",
        layer: "platform",
        retryable: false,
      },
    });
  });

  it("a turn that ran out of its clock is a measured failure, whatever it carried", async () => {
    const { rows } = await runHosted(
      [
        async (opts) => {
          opts.onEngineError?.({
            message: "The AI provider is temporarily unavailable.",
            rawText: "x",
            promptIndex: 0,
            infra: {
              source: "backend_model",
              code: "provider_error",
              httpStatus: 503,
            },
          });
          await new Promise<void>((resolve) =>
            opts.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return {};
        },
      ],
      { ...defaultEvalExecutionBudgets(), turnTimeoutMs: 20 },
    );
    expect(rows[0]).toMatchObject({ status: "completed", passed: false });
    expect(rows[0]!.metadata?.timeout).toMatchObject({ clock: "turn" });
    expect(rows[0]).not.toHaveProperty("infraError");
  });
});

describe("hosted runner — agent-runtime producers", () => {
  it("Claude Code: the bridge's typed provider error is excluded as a provider outage", async () => {
    // What the hosted bridge sends over the wire for a 529 it gave up on.
    const wire = {
      name: "HarnessProviderError",
      message: "API Error: 529 overloaded",
      source: "model",
      code: "claude_code_server_error",
      httpStatus: 529,
    };
    const { rows } = await runHosted([
      failingTurn({
        message: wire.message,
        phase: "stream",
        infra: harnessFailureEvidenceOf(wire),
      }),
    ]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      infraError: {
        class: "provider_unavailable",
        layer: "model",
        code: "claude_code_server_error",
        httpStatus: 529,
      },
    });
  });

  it("Codex: a terminal codexErrorInfo is excluded as a rate limit", async () => {
    const infra = codexProviderEvidenceFromNotification({
      method: "error",
      params: {
        error: {
          message: "exceeded retry limit",
          codexErrorInfo: {
            responseTooManyFailedAttempts: { httpStatusCode: 429 },
          },
        },
        willRetry: false,
      },
    });
    const { rows } = await runHosted([
      failingTurn({ message: "exceeded retry limit", phase: "stream", infra }),
    ]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      infraError: {
        class: "rate_limited",
        code: "codex_responseTooManyFailedAttempts",
        httpStatus: 429,
      },
    });
  });

  it("a typed sandbox setup failure is excluded as a sandbox failure", async () => {
    const { rows } = await runHosted([
      failingTurn({
        message: "computer is not ready",
        phase: "setup",
        infra: {
          source: "sandbox_setup",
          code: "harness_sandbox_unavailable",
          httpStatus: 503,
        },
      }),
    ]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      infraError: { class: "sandbox", layer: "sandbox" },
    });
  });
});

describe("local runner — the provider's own typed answer", () => {
  /** A direct streamText call whose stream carried `error` and nothing else. */
  function streamThatFailedWith(error: unknown) {
    return {
      fullStream: (async function* () {
        yield { type: "error", error };
      })(),
      response: Promise.resolve({ messages: [] }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({}),
      finishReason: Promise.resolve("error"),
    };
  }

  it("an APICallError 503 on the stream is written failed + infraError", async () => {
    streamTextMock.mockReturnValueOnce(
      streamThatFailedWith({
        name: "AI_APICallError",
        message: "Service Unavailable",
        statusCode: 503,
        isRetryable: true,
      }),
    );
    const { rows, recorder } = await runSuite(1, "gpt-4-turbo");
    expect(rows[0]).toMatchObject({
      status: "failed",
      passed: false,
      infraError: {
        class: "provider_unavailable",
        layer: "model",
        httpStatus: 503,
      },
    });
    expect(recorder.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ total: 0 }),
      }),
    );
  });

  it("a provider 401 (a bad key) is an excluded auth failure, even when the result then rejects", async () => {
    // The SDK reports the provider's answer as the stream's error part, then
    // rejects the result promises with a generic "no output" error.
    streamTextMock.mockReturnValueOnce({
      ...streamThatFailedWith({
        name: "AI_APICallError",
        message: "Incorrect API key provided",
        statusCode: 401,
        isRetryable: false,
      }),
      response: Promise.reject(
        Object.assign(new Error("No output generated."), {
          name: "AI_NoOutputGeneratedError",
        }),
      ),
    });
    const { rows } = await runSuite(1, "gpt-4-turbo");
    expect(rows[0]).toMatchObject({
      status: "failed",
      infraError: { class: "auth", layer: "model", retryable: false },
    });
  });

  it("a request the provider rejected (400) is still a measured failure", async () => {
    streamTextMock.mockReturnValueOnce(
      streamThatFailedWith({
        name: "AI_APICallError",
        message: "Invalid schema for function",
        statusCode: 400,
        isRetryable: false,
      }),
    );
    const { rows } = await runSuite(1, "gpt-4-turbo");
    expect(rows[0]).toMatchObject({ status: "completed", passed: false });
    expect(rows[0]).not.toHaveProperty("infraError");
  });
});
