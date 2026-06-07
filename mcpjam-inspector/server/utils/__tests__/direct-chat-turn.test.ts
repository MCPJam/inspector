/**
 * Contract tests for `runDirectChatTurn` (PR 4a of the engine
 * consolidation in `~/mcpjam-docs/unification.md`).
 *
 * Purpose: lock the headless terminal shape that PR 4b will consume from
 * eval's local-BYOK suite path. The closed PR #2458 attempted to inline
 * `streamText` in eval and was rejected for creating a second hand-rolled
 * driver; the rescope extracts `runDirectChatTurn` so chat + eval + the
 * stream UI variants (PR 5) all converge on one configured pipeline.
 *
 * Scope:
 *
 *   - Headless mode resolves to `{messages, steps, totalUsage,
 *     finishReason, spans, aborted}` without requiring a UI writer.
 *   - `traceEvents` is fully optional — the SSE-writer concerns are
 *     caller-side; eval omits them entirely.
 *   - Progressive discovery still wires `prepareStep -> activeTools`
 *     (the chat-side correctness invariant carries over).
 *   - Abort flips `isAborted()` true so callers can drop the result
 *     instead of persisting cancelled state.
 *
 * These tests are wire shape tests, not behavior tests — they assert
 * that the helper's contract matches what PR 4b's eval call site needs.
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

import {
  consumeDirectChatTurnHeadless,
  runDirectChatTurn,
} from "../direct-chat-turn";

describe("runDirectChatTurn — eval headless contract (PR 4a)", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function defaultStreamTextReturn(
    overrides: Partial<{
      messages: Array<{ role: string; content: unknown }>;
      steps: unknown[];
      totalUsage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      finishReason: string;
    }> = {},
  ) {
    return {
      consumeStream: async () => {},
      response: Promise.resolve({
        modelId: "gpt-4-turbo",
        messages: overrides.messages ?? [
          { role: "assistant", content: "Hi" },
        ],
      }),
      steps: Promise.resolve(overrides.steps ?? []),
      totalUsage: Promise.resolve(
        overrides.totalUsage ?? {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      ),
      finishReason: Promise.resolve(overrides.finishReason ?? "stop"),
      toUIMessageStream: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => ({ value: undefined, done: true }) };
        },
      }),
    };
  }

  it("returns a fully assembled result in headless mode (no UI writer)", async () => {
    streamTextMock.mockReturnValueOnce(
      defaultStreamTextReturn({
        messages: [
          { role: "assistant", content: "Done" },
        ],
        totalUsage: {
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
        },
      }),
    );

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hello" } as any],
      systemPrompt: "system",
      tools: {} as any,
    });

    const result = await consumeDirectChatTurnHeadless(handle);

    expect(result.messages).toEqual([{ role: "assistant", content: "Done" }]);
    expect(result.totalUsage.totalTokens).toBe(12);
    expect(result.finishReason).toBe("stop");
    expect(result.aborted).toBe(false);
    expect(Array.isArray(result.spans)).toBe(true);
  });

  it("treats `traceEvents` as fully optional — no UI writer dependency", async () => {
    // PR 4a invariant: eval (PR 4b) calls runDirectChatTurn without ANY
    // `traceEvents`. If the helper internally required a writer or threw
    // when callbacks were absent, eval couldn't drive it headless.
    streamTextMock.mockReturnValueOnce(defaultStreamTextReturn());

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      // traceEvents intentionally omitted.
    });

    await expect(consumeDirectChatTurnHeadless(handle)).resolves.toBeDefined();
  });

  it("threads progressive-discovery `activeTools` through `prepareStep`", async () => {
    // PR 4a invariant: the chat-side active-tool gating from PR 1
    // carries over to the shared helper so eval (PR 4b) gets it for
    // free. `prepareStep` must return `{activeTools: [...]}` when the
    // plan is enabled and the discovery state is populated.
    let prepareStepReturn: any;
    streamTextMock.mockImplementationOnce((options: any) => {
      prepareStepReturn = options.prepareStep({ stepNumber: 0 });
      return defaultStreamTextReturn();
    });

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: { search_tools: { description: "" } } as any,
      progressivePlan: {
        enabled: true,
        reasons: [],
        policy: {
          thresholdPct: 0.03,
          maxToolTokens: 10_000,
          maxToolCount: 30,
          searchLimit: 8,
        },
        catalog: [
          {
            toolId: "search_tools",
            serverId: "meta",
            displayName: "search_tools",
            description: "",
            tokenEstimate: 100,
          },
        ],
        totalTokenEstimate: 100,
      } as any,
      discoveryState: {
        loadedToolIds: new Set(["search_tools"]),
        newlyLoadedToolIds: new Set<string>(),
        pendingApprovalToolIds: new Set<string>(),
        catalogVersion: 1,
      } as any,
    });

    await consumeDirectChatTurnHeadless(handle);

    // Proves the wire: when `progressivePlan.enabled` + `discoveryState`
    // are present, `prepareStep` returns `{activeTools: [...]}` — not
    // `{}`. The exact set depends on the discovery state (meta tools
    // `search_mcp_tools` / `load_mcp_tools` are always loaded), which
    // PR 1 already locks down on the eval side via prepareChatV2 tests.
    expect(prepareStepReturn).toHaveProperty("activeTools");
    expect(Array.isArray(prepareStepReturn.activeTools)).toBe(true);
  });

  it("flips `isAborted` true when the abort signal fires", async () => {
    // PR 4a invariant (mirrors PR 3 "Abort no longer skips persistence"):
    // `streamText` can swallow AbortError silently. The helper exposes
    // `isAborted()` so callers (eval PR 4b, chat) can drop the result
    // cleanly instead of persisting a partial/cancelled turn.
    const controller = new AbortController();
    streamTextMock.mockImplementationOnce(() => {
      controller.abort();
      return defaultStreamTextReturn();
    });

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      abortSignal: controller.signal,
    });

    const result = await consumeDirectChatTurnHeadless(handle);

    expect(result.aborted).toBe(true);
  });

  it("forwards temperature when set; omits when undefined", async () => {
    // PR 4a invariant (carry-over from chat): `temperature` is only
    // included in the streamText options when defined. Eval depends on
    // this — its `prepareChatV2` returns `resolvedTemperature: undefined`
    // when the test case doesn't override, and the SDK default must apply.
    streamTextMock.mockReturnValueOnce(defaultStreamTextReturn());
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      // temperature undefined
    });
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "temperature",
    );

    streamTextMock.mockReturnValueOnce(defaultStreamTextReturn());
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      temperature: 0.42,
    });
    expect(streamTextMock.mock.calls[1]?.[0]).toMatchObject({
      temperature: 0.42,
    });
  });

  it("does not mutate the caller's messageHistory array", async () => {
    // PR 4a invariant (carry-over): `streamText` holds a reference to
    // `messages` and accumulates step responses internally. If the
    // helper mutated the caller's array, the next API call would re-send
    // duplicated items (OpenAI Responses API rejects duplicate ids).
    // The helper uses an internal `traceHistory` copy for trace work.
    streamTextMock.mockReturnValueOnce(
      defaultStreamTextReturn({
        messages: [{ role: "assistant", content: "Reply" }],
      }),
    );
    const messageHistory = [
      { role: "user", content: "Hello" } as any,
    ];
    const snapshotLen = messageHistory.length;

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory,
      systemPrompt: "s",
      tools: {} as any,
    });
    await consumeDirectChatTurnHeadless(handle);

    expect(messageHistory.length).toBe(snapshotLen);
  });
});
