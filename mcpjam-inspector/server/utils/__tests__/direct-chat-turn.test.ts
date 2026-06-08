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

  it("keeps non-cataloged injected tools advertisable under progressive discovery", async () => {
    // Regression: progressive discovery narrows the default set to the cataloged
    // active subset, which never contains tools injected after plan-build (the
    // eval `computer` / `finish_widget`). `prepareAdvertisedTools` can only KEEP
    // names already in the default set, so without the injected-tools union
    // those tools could never be advertised even once a widget mounts.
    let prepareStepReturn: any;
    let seenDefaultNames: string[] = [];
    streamTextMock.mockImplementationOnce((options: any) => {
      prepareStepReturn = options.prepareStep({ stepNumber: 0 });
      return defaultStreamTextReturn();
    });

    const handle = runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "claude-opus-4-8",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {
        search_tools: { description: "", execute: async () => ({}) },
        computer: { description: "c", execute: async () => ({}) },
        finish_widget: { description: "f", execute: async () => ({}) },
      } as any,
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
            toolId: "srv::search_tools",
            modelName: "search_tools",
            serverId: "srv",
            originalName: "search_tools",
            description: "",
            fields: [],
            inputSchema: {},
            tokenEstimate: 100,
          },
        ],
        totalTokenEstimate: 100,
      } as any,
      discoveryState: {
        loadedToolIds: new Set(["srv::search_tools"]),
        newlyLoadedToolIds: new Set<string>(),
        pendingApprovalToolIds: new Set<string>(),
      } as any,
      // Simulate a mounted widget: keep the full default set (no narrowing).
      prepareAdvertisedTools: ({ defaultToolNames }) => {
        seenDefaultNames = defaultToolNames;
        return defaultToolNames;
      },
    });

    await consumeDirectChatTurnHeadless(handle);

    // The injected tools reach the hook's default set...
    expect(seenDefaultNames).toEqual(
      expect.arrayContaining(["computer", "finish_widget"]),
    );
    // ...and survive into the advertised activeTools for the step.
    expect(prepareStepReturn.activeTools).toEqual(
      expect.arrayContaining(["computer", "finish_widget", "search_tools"]),
    );
  });

  it("narrows the request_payload trace tools via prepareAdvertisedTools (step 0)", () => {
    streamTextMock.mockReturnValueOnce(defaultStreamTextReturn());
    let payloadTools: Record<string, unknown> | undefined;
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "hi" } as any],
      systemPrompt: "system",
      tools: {
        search: { description: "s" } as any,
        computer: { description: "c" } as any,
        finish_widget: { description: "f" } as any,
      },
      // Hide computer/finish_widget at step 0 (no widget rendered yet).
      prepareAdvertisedTools: ({ defaultToolNames }) =>
        defaultToolNames.filter(
          (n) => n !== "computer" && n !== "finish_widget",
        ),
      traceEvents: {
        onRequestPayload: (event) => {
          payloadTools = event.tools as Record<string, unknown>;
        },
      },
    });
    // The request_payload trace must reflect the narrowed step-0 advertised set
    // (regression: previously it emitted the full tools map).
    expect(payloadTools && Object.keys(payloadTools)).toEqual(["search"]);
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

  it("removes the abort listener on synchronous streamText throw (PR 4a review)", async () => {
    // Cursor PR 4a review #2 / CodeRabbit "outside-diff": the pre-refactor
    // inline code at chat-v2's call site try/caught the synchronous
    // `streamText` call and removed the abort listener. The helper owns
    // the listener now, so it must own that cleanup — otherwise a sync
    // throw leaks the listener and the SSE caller has no handle to
    // call `cleanup()` against.
    streamTextMock.mockImplementationOnce(() => {
      throw new Error("synthetic sync provider error");
    });

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    expect(() =>
      runDirectChatTurn({
        llmModel: { id: "mock" } as any,
        modelId: "gpt-4-turbo",
        messageHistory: [{ role: "user", content: "Hi" } as any],
        systemPrompt: "s",
        tools: {} as any,
        abortSignal: controller.signal,
      }),
    ).toThrow(/synthetic sync provider error/);

    // The listener that was attached during construction must be removed
    // on throw — same number of adds and removes.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // MCPJam-parity callbacks (engine consolidation — route 3 collapse).
  //
  // `runDirectChatTurn` exposes three top-level callbacks mirrored from
  // `MCPJamHandlerOptions` so all four chat routes converge on the same
  // consumer surface: `onLiveTextDelta`, `onStepFinish`, `onEngineError`.
  // Each fires alongside the existing trace callbacks, is safe-fired
  // (try/catch with `logger.warn`), and is fully optional.
  // ---------------------------------------------------------------------
  it("fires onLiveTextDelta once per text-delta chunk with the chunk text", async () => {
    streamTextMock.mockImplementationOnce((options: any) => {
      // Drive two text-delta chunks through the engine's `onChunk`.
      void options.onChunk({ chunk: { type: "text-delta", text: "Hel" } });
      void options.onChunk({ chunk: { type: "text-delta", text: "lo" } });
      return defaultStreamTextReturn();
    });
    const deltas: string[] = [];
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      onLiveTextDelta: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("fires onStepFinish per step with cumulative turn usage + span snapshot", async () => {
    streamTextMock.mockImplementationOnce((options: any) => {
      // Drive a step that has usage signal + a couple response messages.
      void options.onStepFinish({
        response: { messages: [{ role: "assistant", content: "ok" }] },
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        toolCalls: [],
      });
      return defaultStreamTextReturn();
    });
    const events: any[] = [];
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      onStepFinish: (event) => events.push(event),
    });
    expect(events).toHaveLength(1);
    expect(events[0].stepIndex).toBe(0);
    expect(events[0].promptIndex).toBeGreaterThanOrEqual(0);
    expect(events[0].settledWithError).toBe(false);
    expect(events[0].turnUsage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
    expect(Array.isArray(events[0].turnSpans)).toBe(true);
  });

  it("fires onEngineError before onTurnError (and not on abort)", async () => {
    const order: string[] = [];
    streamTextMock.mockImplementationOnce((options: any) => {
      void options.onError({ error: new Error("provider exploded") });
      return defaultStreamTextReturn();
    });
    const engineErrors: any[] = [];
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      onEngineError: (event) => {
        order.push("engine");
        engineErrors.push(event);
      },
      traceEvents: {
        onTurnError: () => order.push("turn"),
      },
    });
    expect(order).toEqual(["engine", "turn"]);
    expect(engineErrors[0]).toMatchObject({
      message: "provider exploded",
      rawText: "provider exploded",
      stepIndex: 0,
    });
    expect(engineErrors[0].promptIndex).toBeGreaterThanOrEqual(0);

    // Abort path: onEngineError must NOT fire.
    const aborts: any[] = [];
    const controller = new AbortController();
    streamTextMock.mockImplementationOnce((options: any) => {
      controller.abort();
      void options.onError({ error: new Error("aborted") });
      return defaultStreamTextReturn();
    });
    runDirectChatTurn({
      llmModel: { id: "mock" } as any,
      modelId: "gpt-4-turbo",
      messageHistory: [{ role: "user", content: "Hi" } as any],
      systemPrompt: "s",
      tools: {} as any,
      abortSignal: controller.signal,
      onEngineError: (event) => aborts.push(event),
    });
    expect(aborts).toHaveLength(0);
  });

  it("safe-fires the parity callbacks — a throw does not crash the turn", async () => {
    streamTextMock.mockImplementationOnce((options: any) => {
      void options.onChunk({ chunk: { type: "text-delta", text: "x" } });
      void options.onStepFinish({
        response: { messages: [] },
        usage: undefined,
        toolCalls: [],
      });
      void options.onError({ error: new Error("boom") });
      return defaultStreamTextReturn();
    });
    expect(() =>
      runDirectChatTurn({
        llmModel: { id: "mock" } as any,
        modelId: "gpt-4-turbo",
        messageHistory: [{ role: "user", content: "Hi" } as any],
        systemPrompt: "s",
        tools: {} as any,
        onLiveTextDelta: () => {
          throw new Error("delta consumer threw");
        },
        onStepFinish: () => {
          throw new Error("step consumer threw");
        },
        onEngineError: () => {
          throw new Error("engine-error consumer threw");
        },
      }),
    ).not.toThrow();
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
