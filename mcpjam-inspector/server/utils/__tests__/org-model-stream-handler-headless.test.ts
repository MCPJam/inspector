/**
 * runLocalOrgChatTurnHeadless — the headless sibling of
 * `handleLocalOrgChatModel` used by the synthetic-session runner. Locks the
 * route-3 invariants the SSE handler enforces: model validation before the
 * engine runs, the 30-step default, the unconditional `postLocalUsage`
 * writeback, the `streamErrored` ingestion gate (throw instead of silently
 * returning a partial transcript), and the deduped history rebuild.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const runDirectChatTurnMock = vi.fn();
const consumeDirectChatTurnHeadlessMock = vi.fn();
const assertOrgModelAllowedMock = vi.fn();
const buildOrgModelFromResolvedConfigMock = vi.fn();

vi.mock("../direct-chat-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../direct-chat-turn.js")
  >("../direct-chat-turn.js");
  return {
    ...actual,
    runDirectChatTurn: (...args: unknown[]) => runDirectChatTurnMock(...args),
    consumeDirectChatTurnHeadless: (...args: unknown[]) =>
      consumeDirectChatTurnHeadlessMock(...args),
  };
});

vi.mock("@mcpjam/sdk/model-factory", async () => {
  const actual = await vi.importActual<
    typeof import("@mcpjam/sdk/model-factory")
  >("@mcpjam/sdk/model-factory");
  return {
    ...actual,
    assertOrgModelAllowed: (...args: unknown[]) =>
      assertOrgModelAllowedMock(...args),
    buildOrgModelFromResolvedConfig: (...args: unknown[]) =>
      buildOrgModelFromResolvedConfigMock(...args),
  };
});

import { runLocalOrgChatTurnHeadless } from "../org-model-stream-handler.js";

const PROVIDER = { providerKey: "openai" } as never;
const MESSAGES: ModelMessage[] = [{ role: "user", content: "hi" }];
const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans: [],
} as never;

const baseOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    provider: PROVIDER,
    projectId: "proj-1",
    modelId: "llama3",
    chatSessionId: "sess_1",
    sourceType: "chatbox",
    messages: MESSAGES,
    systemPrompt: "system",
    tools: {},
    authHeader: "Bearer abc",
    synthesisRunId: "run-xyz",
    ...overrides,
  }) as Parameters<typeof runLocalOrgChatTurnHeadless>[0];

/**
 * Configure the engine mocks for one turn. `consume` simulates the engine
 * lifecycle: optionally fire `onEngineError`, then `onPersist` (the real
 * engine's onFinish fires onPersist on every non-aborted completion, even
 * after a mid-stream error), then resolve the headless result.
 */
function stubEngineTurn(params: {
  responseMessages?: ModelMessage[];
  engineError?: { message: string };
  aborted?: boolean;
  skipPersist?: boolean;
}) {
  const captured: { options?: any } = {};
  runDirectChatTurnMock.mockImplementation((options: any) => {
    captured.options = options;
    return { handleSentinel: true };
  });
  consumeDirectChatTurnHeadlessMock.mockImplementation(async () => {
    const options = captured.options!;
    if (params.engineError) {
      options.onEngineError?.({
        message: params.engineError.message,
        rawText: params.engineError.message,
        promptIndex: 0,
      });
    }
    if (!params.aborted && !params.skipPersist) {
      await options.onPersist?.({
        responseMessages: params.responseMessages ?? [],
        assistantText: "",
        toolCalls: [],
        toolResults: [],
        turnTrace: TURN_TRACE,
      });
    }
    return {
      messages: params.responseMessages ?? [],
      steps: [],
      totalUsage: {},
      finishReason: "stop",
      spans: [],
      aborted: params.aborted === true,
    };
  });
  return captured;
}

describe("runLocalOrgChatTurnHeadless", () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    globalThis.fetch = fetchMock as never;
    runDirectChatTurnMock.mockReset();
    consumeDirectChatTurnHeadlessMock.mockReset();
    assertOrgModelAllowedMock.mockReset();
    buildOrgModelFromResolvedConfigMock.mockReset();
    buildOrgModelFromResolvedConfigMock.mockReturnValue({ model: true });
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it("validates the model, applies the 30-step default, and returns the deduped history + trace", async () => {
    const assistantReply: ModelMessage = {
      role: "assistant",
      content: "hello!",
    };
    const captured = stubEngineTurn({ responseMessages: [assistantReply] });

    const result = await runLocalOrgChatTurnHeadless(baseOptions());

    expect(assertOrgModelAllowedMock).toHaveBeenCalledWith(PROVIDER, "llama3");
    expect(buildOrgModelFromResolvedConfigMock).toHaveBeenCalledWith(
      PROVIDER,
      "llama3",
    );
    // Route-3 default preserved (hosted MCPJam parity).
    expect(captured.options.maxSteps).toBe(30);
    expect(result.aborted).toBe(false);
    expect(result.turnTrace).toEqual(TURN_TRACE);
    expect(result.messages).toEqual([...MESSAGES, assistantReply]);
  });

  it("posts the usage writeback with synthesisRunId (fire-and-forget billing)", async () => {
    stubEngineTurn({ responseMessages: [] });

    await runLocalOrgChatTurnHeadless(baseOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://convex.test/stream/org/local-usage");
    expect(JSON.parse(init.body)).toMatchObject({
      projectId: "proj-1",
      providerKey: "openai",
      model: "llama3",
      synthesisRunId: "run-xyz",
    });
  });

  it("throws on a mid-stream engine error AFTER the usage writeback fired (ingestion gated, billing not)", async () => {
    stubEngineTurn({
      responseMessages: [],
      engineError: { message: "provider exploded" },
    });

    await expect(
      runLocalOrgChatTurnHeadless(baseOptions()),
    ).rejects.toThrow(/provider exploded/);
    // onPersist ran (engine fires it after error too): billing posted…
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws the tool_approval_unsupported guard before running the engine", async () => {
    await expect(
      runLocalOrgChatTurnHeadless(
        baseOptions({
          requireToolApproval: true,
          tools: { search: { description: "noop" } },
        }),
      ),
    ).rejects.toThrow(/Tool approval is not supported/i);
    expect(runDirectChatTurnMock).not.toHaveBeenCalled();
  });

  it("throws config/allowlist failures instead of returning an error stream", async () => {
    assertOrgModelAllowedMock.mockImplementation(() => {
      throw new Error("model not allowed for this org");
    });

    await expect(
      runLocalOrgChatTurnHeadless(baseOptions()),
    ).rejects.toThrow(/not allowed/);
    expect(runDirectChatTurnMock).not.toHaveBeenCalled();
  });

  it("returns aborted without throwing when the signal fired mid-turn", async () => {
    stubEngineTurn({ aborted: true });

    const result = await runLocalOrgChatTurnHeadless(baseOptions());
    expect(result).toEqual({ messages: MESSAGES, aborted: true });
  });

  it("forwards prepareAdvertisedTools and onToolResultChunk to the engine", async () => {
    const captured = stubEngineTurn({ responseMessages: [] });
    const prepareAdvertisedTools = vi.fn();
    const onToolResultChunk = vi.fn();

    await runLocalOrgChatTurnHeadless(
      baseOptions({ prepareAdvertisedTools, onToolResultChunk }),
    );

    expect(captured.options.prepareAdvertisedTools).toBe(
      prepareAdvertisedTools,
    );
    expect(captured.options.traceEvents?.onToolResultChunk).toBe(
      onToolResultChunk,
    );
  });
});
