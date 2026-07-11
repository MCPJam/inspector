import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelDefinition } from "@/shared/types";

/**
 * PR 3a: `drainAssistantTurn` is now a thin wrapper over `resolveTurnRuntime`
 * + `runUnifiedAssistantTurn`. These tests exercise the REAL adapter + facade
 * end-to-end, mocking only the leaf engines (`runAssistantTurn` for the hosted
 * branch, `runDirectChatTurn` / `consumeDirectChatTurnHeadless` for the direct
 * branch), the org model-factory (local model build), and `fetch` (the
 * local-usage writeback). That way the byte-parity contract — hosted endpoints
 * + extra body fields, the direct engine's 30-step default, the local-usage
 * writeback — is asserted against the actual wiring, not a re-stub of it.
 */

const runAssistantTurnMock = vi.fn();
const runDirectChatTurnMock = vi.fn();
const consumeDirectChatTurnHeadlessMock = vi.fn();
const assertOrgModelAllowedMock = vi.fn();
const buildOrgModelFromResolvedConfigMock = vi.fn();
// `resolveSyntheticModelSource` is the resolution boundary both `drainAssistantTurn`
// (via `resolveTurnRuntime`) and the empty-session fallback use.
const resolveSyntheticModelSourceMock = vi.fn();

vi.mock("../../../utils/assistant-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/assistant-turn.js")
  >("../../../utils/assistant-turn.js");
  return {
    ...actual,
    runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
  };
});

vi.mock("../../../utils/direct-chat-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/direct-chat-turn.js")
  >("../../../utils/direct-chat-turn.js");
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

vi.mock("../../../utils/org-model-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-config.js")
  >("../../../utils/org-model-config.js");
  return {
    ...actual,
    resolveSyntheticModelSource: (...args: unknown[]) =>
      resolveSyntheticModelSourceMock(...args),
  };
});

import { drainAssistantTurn } from "../runner.js";

const TURN_TRACE = {
  turnId: "test-turn",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 0,
  spans: [],
  usage: { totalTokens: 7 },
  finishReason: "stop",
};

/**
 * Stub the hosted engine (`runAssistantTurn`): capture options, return the
 * input messages + a turnTrace as a successful headless turn.
 */
function buildHostedEngineStub(captureCalls: unknown[]) {
  return vi.fn(async (opts: any) => {
    captureCalls.push(opts);
    return {
      messages: opts.messages,
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
      turnTrace: TURN_TRACE,
    };
  });
}

/**
 * Stub the direct engine pair. `runDirectChatTurn` captures options + returns a
 * handle; `consumeDirectChatTurnHeadless` returns a successful headless result.
 */
function stubDirectEngine(
  captureCalls: unknown[],
  overrides: { aborted?: boolean; engineError?: { message: string } } = {},
) {
  runDirectChatTurnMock.mockImplementation((opts: any) => {
    captureCalls.push(opts);
    if (overrides.engineError) {
      opts.onEngineError?.({
        message: overrides.engineError.message,
        rawText: overrides.engineError.message,
        promptIndex: 0,
      });
    }
    return { handleSentinel: true };
  });
  consumeDirectChatTurnHeadlessMock.mockImplementation(async () => ({
    messages: [{ role: "assistant", content: "local reply" }],
    steps: [],
    totalUsage: { totalTokens: 7 },
    finishReason: "stop",
    spans: [],
    turnTrace: TURN_TRACE,
    aborted: overrides.aborted === true,
  }));
}

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  modelId: "openai/gpt-4o-mini",
  systemPrompt: "system",
  tools: {} as any,
  mcpClientManager: {} as any,
  chatSessionId: "sess_1",
  selectedServers: ["server-a"],
  projectId: "proj-1",
  authHeader: "Bearer abc",
  synthesisRunId: "run-xyz",
  modelDefinition: {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "openai",
  } as ModelDefinition,
  ...overrides,
});

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  globalThis.fetch = fetchMock as never;
  runAssistantTurnMock.mockReset();
  runDirectChatTurnMock.mockReset();
  consumeDirectChatTurnHeadlessMock.mockReset();
  assertOrgModelAllowedMock.mockReset();
  buildOrgModelFromResolvedConfigMock.mockReset();
  buildOrgModelFromResolvedConfigMock.mockReturnValue({ model: true });
  resolveSyntheticModelSourceMock.mockReset();
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("drainAssistantTurn — model-aware dispatch", () => {
  it("routes MCPJam-provided models through the hosted engine on the default /stream endpoint", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildHostedEngineStub(calls));
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const result = await drainAssistantTurn(
      baseArgs() as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runAssistantTurnMock).toHaveBeenCalledTimes(1);
    expect(runDirectChatTurnMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("mcpjam");
    expect(result.turnTrace).toEqual(TURN_TRACE);
    const opts = calls[0] as any;
    expect(opts.synthesisRunId).toBe("run-xyz");
    expect(opts.approvalMode).toBe("auto-deny");
    expect(opts.streamSink).toBe("none");
    expect(opts.persistMode).toBe("caller");
    expect(opts.sourceType).toBe("chatbox");
    expect(opts.origin).toBe("chatbox");
    expect(opts.authContext).toEqual({
      kind: "user_bearer",
      token: "Bearer abc",
    });
    // JAM-paid path pins the default `/stream` endpoint. The old dispatch left
    // endpointPath undefined; passing "/stream" is byte-identical on the wire
    // (`resolvedEndpointPath = endpointPath ?? "/stream"`).
    expect(opts.endpointPath).toBe("/stream");
    // MCPJam never sets a providerKey.
    expect(opts.extraBodyFields?.providerKey).toBeUndefined();
    // Hosted engines never post the local-usage writeback.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes cloud-runtime BYOK models through /stream/org with providerKey + serverIds", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildHostedEngineStub(calls));
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "byok",
      orgRuntime: { runtimeLocation: "cloud", providerKey: "anthropic" },
    });

    const result = await drainAssistantTurn(
      baseArgs({
        modelId: "claude-3-5-sonnet-latest",
        modelDefinition: {
          id: "claude-3-5-sonnet-latest",
          name: "Claude",
          provider: "anthropic",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runAssistantTurnMock).toHaveBeenCalledTimes(1);
    expect(runDirectChatTurnMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("byok");
    const opts = calls[0] as any;
    // Hosted org-BYOK contract — byte-matching `handleHostedOrgChatModel`.
    expect(opts.endpointPath).toBe("/stream/org");
    expect(opts.extraBodyFields).toMatchObject({
      providerKey: "anthropic",
      serverIds: ["server-a"],
    });
    expect(opts.synthesisRunId).toBe("run-xyz");
    expect(opts.approvalMode).toBe("auto-deny");
    expect(opts.streamSink).toBe("none");
    expect(opts.persistMode).toBe("caller");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes local-runtime BYOK models through the direct engine with the 30-step default and posts the usage writeback", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls);
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    const result = await drainAssistantTurn(
      baseArgs({
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runDirectChatTurnMock).toHaveBeenCalledTimes(1);
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("local_byok");
    expect(result.turnTrace).toEqual(TURN_TRACE);

    const opts = calls[0] as any;
    // Local handler's 30-step default (the direct engine's own default is 20).
    expect(opts.maxSteps).toBe(30);
    // Byte-parity: the old local path never forwarded a provider string to the
    // direct engine, so its trace spans carried no provider metadata.
    expect(opts.provider).toBeUndefined();

    // The local-usage writeback fired with the synthesisRunId attribution.
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
      // turnId + promptIndex are sourced from the turn trace (byte-parity).
      turnId: "test-turn",
      promptIndex: 0,
      serverIds: ["server-a"],
    });
  });

  it("tags the HOSTED engine turn with sourceType:\"swarm\" when the swarm surface drives the turn", async () => {
    // CONTRACT (finding 3): the swarm runner passes `persist.sourceType` =
    // "swarm" into drainAssistantTurn. That must reach the hosted engine's
    // sourceType so hosted usage rows are attributed to the journey surface —
    // NOT hardcoded to "chatbox" like the session-simulation surface.
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildHostedEngineStub(calls));
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    await drainAssistantTurn(
      baseArgs({
        sourceType: "swarm",
        // Swarm attribution rides journeyRunId (not synthesisRunId). hostId
        // travels WITH it — the drain fails closed on partial swarm identity.
        synthesisRunId: undefined,
        journeyRunId: "journey-run-1",
        hostId: "host-1",
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    const opts = calls[0] as any;
    expect(opts.sourceType).toBe("swarm");
    // The default-endpoint hosted path is still used; the journey attribution
    // rides `rt.runtime.extraBodyFields` (asserted at the wire level in the
    // local-usage test below).
    expect(opts.origin).toBe("chatbox");
  });

  it("posts the local-BYOK usage writeback with sourceType:\"swarm\" for the swarm surface", async () => {
    // CONTRACT (finding 3): the local-BYOK usage writeback row must also carry
    // "swarm" so per-journey local spend is attributed correctly.
    const calls: unknown[] = [];
    stubDirectEngine(calls);
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    await drainAssistantTurn(
      baseArgs({
        sourceType: "swarm",
        synthesisRunId: undefined,
        journeyRunId: "journey-run-1",
        hostId: "host-1",
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://convex.test/stream/org/local-usage");
    const body = JSON.parse(init.body);
    expect(body.sourceType).toBe("swarm");
    expect(body.journeyRunId).toBe("journey-run-1");
  });

  it("FAILS CLOSED on partial swarm identity (journeyRunId without hostId, and vice versa)", async () => {
    // journeyRunId + hostId are ONE identity — the swarm-chat continuity lane
    // and ingest attribution key on both. A turn carrying only one is a runner
    // wiring bug; silently proceeding would emit incomplete attribution.
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    await expect(
      drainAssistantTurn(
        baseArgs({
          sourceType: "swarm",
          synthesisRunId: undefined,
          journeyRunId: "journey-run-1",
          // hostId missing
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/partial continuity identity/i);

    await expect(
      drainAssistantTurn(
        baseArgs({
          sourceType: "swarm",
          synthesisRunId: undefined,
          hostId: "host-1",
          // journeyRunId missing
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/partial continuity identity/i);
  });

  it("refuses local-runtime BYOK + requireToolApproval=true with non-empty tools before building the model", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    await expect(
      drainAssistantTurn(
        baseArgs({
          modelId: "llama3",
          modelDefinition: {
            id: "llama3",
            name: "Llama3 local",
            provider: "ollama",
          } as ModelDefinition,
          requireToolApproval: true,
          tools: { search: { description: "noop" } } as any,
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/approval-required tool calls.*Disable tool approval/i);

    // Refusal happens before the model is built or the engine is invoked.
    expect(buildOrgModelFromResolvedConfigMock).not.toHaveBeenCalled();
    expect(runDirectChatTurnMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still dispatches local-runtime BYOK when requireToolApproval is false", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls);
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    await drainAssistantTurn(
      baseArgs({
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
        requireToolApproval: false,
        tools: { search: { description: "noop" } } as any,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runDirectChatTurnMock).toHaveBeenCalledTimes(1);
  });

  it("throws with a clear message when org-BYOK derivation fails", async () => {
    resolveSyntheticModelSourceMock.mockRejectedValue(
      new Error(
        "Synthetic dispatch failed to derive org provider key: missing customProviderName",
      ),
    );

    await expect(
      drainAssistantTurn(
        baseArgs({
          modelId: "custom-thing",
          modelDefinition: {
            id: "custom-thing",
            name: "Custom",
            provider: "custom",
          } as ModelDefinition,
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/derive org provider key/i);
  });
});

describe("drainAssistantTurn — engine error surfacing", () => {
  it("throws when the hosted engine reports an error and produces no turnTrace (spend-cap classification path)", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    runAssistantTurnMock.mockImplementation(async (opts: any) => {
      opts.onEngineError?.({
        message: "Daily spend cap reached for free models",
        code: "spend_cap_exceeded",
        httpStatus: 429,
        rawText: "{}",
        promptIndex: 0,
      });
      return {
        messages: opts.messages,
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
      };
    });

    await expect(
      drainAssistantTurn(baseArgs() as Parameters<typeof drainAssistantTurn>[0]),
    ).rejects.toThrow(/spend cap.*spend_cap_exceeded.*HTTP 429/i);
  });

  it("throws when the hosted engine returns no turnTrace even WITHOUT a captured engine error", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    runAssistantTurnMock.mockImplementation(async (opts: any) => ({
      messages: opts.messages,
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
    }));

    await expect(
      drainAssistantTurn(baseArgs() as Parameters<typeof drainAssistantTurn>[0]),
    ).rejects.toThrow(/engine returned no turn trace/i);
  });

  it("does not throw on a missing turnTrace when the abort signal fired (cancellation, not failure)", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    const controller = new AbortController();
    runAssistantTurnMock.mockImplementation(async (opts: any) => {
      controller.abort();
      return {
        messages: opts.messages,
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
      };
    });

    const result = await drainAssistantTurn(
      baseArgs({
        abortSignal: controller.signal,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );
    expect(result.turnTrace).toBeUndefined();
  });

  it("does not throw when a turnTrace was produced despite a recovered per-step engine error", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    runAssistantTurnMock.mockImplementation(async (opts: any) => {
      opts.onEngineError?.({
        message: "transient step error",
        rawText: "{}",
        promptIndex: 0,
      });
      return {
        messages: opts.messages,
        assistantMessages: [],
        toolCalls: [],
        toolResults: [],
        turnTrace: TURN_TRACE,
      };
    });

    const result = await drainAssistantTurn(
      baseArgs() as Parameters<typeof drainAssistantTurn>[0],
    );
    expect(result.turnTrace).toEqual(TURN_TRACE);
  });

  it("bills the consumed usage on a fatal direct-engine error, THEN throws", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls, { engineError: { message: "provider exploded" } });
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    await expect(
      drainAssistantTurn(
        baseArgs({
          modelId: "llama3",
          modelDefinition: {
            id: "llama3",
            name: "Llama3 local",
            provider: "ollama",
          } as ModelDefinition,
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/provider exploded/);
    // A local-BYOK turn that consumed tokens then errored mid-stream must STILL
    // post the /stream/org/local-usage writeback — matching the old
    // `buildLocalOrgOnPersist`, which billed unconditionally on non-abort and
    // only gated transcript persistence on the error (cubic P1: undercount).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toContain(
      "/stream/org/local-usage",
    );
  });

  it("returns the aborted direct turn without persisting or billing", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls, { aborted: true });
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    const input = [{ role: "user", content: "hi" }];
    const result = await drainAssistantTurn(
      baseArgs({
        messages: input,
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );
    expect(result.turnTrace).toBeUndefined();
    // Aborted turns return the input history unchanged and never bill.
    expect(result.history).toEqual(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SUCCEEDS a local-BYOK turn even when the usage writeback fetch REJECTS (best-effort billing)", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls);
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });
    // Parity with the OLD fire-and-forget `postLocalUsage(...).catch(...)`: a
    // `/stream/org/local-usage` outage must NOT fail an otherwise-successful
    // synthetic turn (the caller would then discard the session).
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await drainAssistantTurn(
      baseArgs({
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    // Turn resolves successfully; the rejection was swallowed/logged.
    expect(result.turnTrace).toEqual(TURN_TRACE);
    expect(result.modelSource).toBe("local_byok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds local-BYOK history with dedup so response messages overlapping the input prefix don't double-write", async () => {
    const calls: unknown[] = [];
    runDirectChatTurnMock.mockImplementation((opts: any) => {
      calls.push(opts);
      return { handleSentinel: true };
    });
    const input = [{ role: "user", content: "hi" }];
    // The engine's response slice re-includes the input-history prefix (the AI
    // SDK can echo prior messages by id / JSON identity). The old local path
    // did `capturedHistory = [...messages]; appendDedupedModelMessages(...)`,
    // so overlapping entries were deduped out of the persisted transcript.
    consumeDirectChatTurnHeadlessMock.mockImplementation(async () => ({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "local reply" },
      ],
      steps: [],
      totalUsage: { totalTokens: 7 },
      finishReason: "stop",
      spans: [],
      turnTrace: TURN_TRACE,
      aborted: false,
    }));
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    const result = await drainAssistantTurn(
      baseArgs({
        messages: input,
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    // No duplicate of the input `user: hi` message.
    expect(result.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "local reply" },
    ]);
  });

  it("threads hosted turn hooks into the engine call (browser session context attachment)", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildHostedEngineStub(calls));
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const prepareAdvertisedTools = vi.fn();

    await drainAssistantTurn(
      baseArgs({
        hooks: { onToolCall, onToolResult, prepareAdvertisedTools },
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    const opts = calls[0] as any;
    expect(opts.onToolCall).toBe(onToolCall);
    expect(opts.onToolResult).toBe(onToolResult);
    expect(opts.prepareAdvertisedTools).toBe(prepareAdvertisedTools);
  });

  it("threads local-branch hooks into the direct engine (prepareAdvertisedTools + onToolResultChunk)", async () => {
    const calls: unknown[] = [];
    stubDirectEngine(calls);
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    const prepareAdvertisedTools = vi.fn();
    const onToolResultChunk = vi.fn();

    await drainAssistantTurn(
      baseArgs({
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
        hooks: { prepareAdvertisedTools, onToolResultChunk },
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    const opts = calls[0] as any;
    expect(opts.prepareAdvertisedTools).toBe(prepareAdvertisedTools);
    // The facade maps the chunk hook into the direct engine's traceEvents.
    expect(opts.traceEvents?.onToolResultChunk).toBe(onToolResultChunk);
  });
});
