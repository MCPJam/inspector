import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelDefinition } from "@/shared/types";

const runAssistantTurnMock = vi.fn();
const runLocalOrgChatTurnHeadlessMock = vi.fn();
// The runner calls the shared `resolveSyntheticModelSource` helper which
// internally calls `resolveOrgProviderRuntime`. Mocking the latter via
// module mocking doesn't intercept the call because both functions live
// in the SAME module (vitest module mocks only intercept cross-module
// imports). Mock the public entry point instead — that's also the
// boundary the empty-session fallback uses, so the test naturally
// exercises the same surface as production.
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

vi.mock("../../../utils/org-model-stream-handler.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-stream-handler.js")
  >("../../../utils/org-model-stream-handler.js");
  return {
    ...actual,
    runLocalOrgChatTurnHeadless: (...args: unknown[]) =>
      runLocalOrgChatTurnHeadlessMock(...args),
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
};

/**
 * `drainAssistantTurn` drives turns headlessly: the engine branches call
 * `runAssistantTurn` (streamSink: "none") whose result carries the
 * transcript synchronously; the local org-BYOK branch calls
 * `runLocalOrgChatTurnHeadless`. The stubs return the input messages as
 * the post-turn history plus a turnTrace, mirroring a successful turn.
 */
function buildEngineStub(captureCalls: unknown[]) {
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

function buildLocalHeadlessStub(captureCalls: unknown[]) {
  return vi.fn(async (opts: any) => {
    captureCalls.push(opts);
    return {
      messages: opts.messages,
      turnTrace: TURN_TRACE,
      aborted: false,
    };
  });
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

describe("drainAssistantTurn — model-aware dispatch", () => {
  beforeEach(() => {
    runAssistantTurnMock.mockReset();
    runLocalOrgChatTurnHeadlessMock.mockReset();
    resolveSyntheticModelSourceMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches MCPJam-provided models through runAssistantTurn headlessly with synthesisRunId as a typed option", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildEngineStub(calls));
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const result = await drainAssistantTurn(
      baseArgs() as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runAssistantTurnMock).toHaveBeenCalledTimes(1);
    expect(runLocalOrgChatTurnHeadlessMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("mcpjam");
    expect(result.turnTrace).toEqual(TURN_TRACE);
    const opts = calls[0] as any;
    // `runAssistantTurn` itself appends synthesisRunId to extraBodyFields,
    // so the wire body matches the old handler-built shape.
    expect(opts.synthesisRunId).toBe("run-xyz");
    expect(opts.approvalMode).toBe("auto-deny");
    // Headless contract: no SSE Response, caller-owned persistence.
    expect(opts.streamSink).toBe("none");
    expect(opts.persistMode).toBe("caller");
    expect(opts.sourceType).toBe("chatbox");
    expect(opts.origin).toBe("chatbox");
    expect(opts.authContext).toEqual({
      kind: "user_bearer",
      token: "Bearer abc",
    });
    // JAM-paid path stays on the default `/stream` endpoint.
    expect(opts.endpointPath).toBeUndefined();
  });

  it("dispatches non-MCPJam models with cloud runtime through runAssistantTurn at /stream/org with providerKey + serverIds", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildEngineStub(calls));
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
    expect(runLocalOrgChatTurnHeadlessMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("byok");
    const opts = calls[0] as any;
    // Hosted org-BYOK contract — byte-matching what
    // `handleHostedOrgChatModel` constructed before the headless refactor.
    expect(opts.endpointPath).toBe("/stream/org");
    expect(opts.extraBodyFields).toMatchObject({
      providerKey: "anthropic",
      serverIds: ["server-a"],
    });
    expect(opts.synthesisRunId).toBe("run-xyz");
    // Synthetic runs must auto-deny approval-required tool calls — there
    // is no human in the loop. Regression guard for #2486 PR review.
    expect(opts.approvalMode).toBe("auto-deny");
    expect(opts.streamSink).toBe("none");
    expect(opts.persistMode).toBe("caller");
  });

  it("dispatches non-MCPJam models with local runtime through runLocalOrgChatTurnHeadless and threads synthesisRunId as a typed option", async () => {
    const calls: unknown[] = [];
    runLocalOrgChatTurnHeadlessMock.mockImplementation(
      buildLocalHeadlessStub(calls),
    );
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as any,
      },
    });

    const result = await drainAssistantTurn(
      baseArgs({
        // ollama is in isLocalRuntimeEligible's allow-list (custom: also is).
        modelId: "llama3",
        modelDefinition: {
          id: "llama3",
          name: "Llama3 local",
          provider: "ollama",
        } as ModelDefinition,
      }) as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(runLocalOrgChatTurnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("local_byok");
    expect(result.turnTrace).toEqual(TURN_TRACE);
    const opts = calls[0] as any;
    expect(opts.synthesisRunId).toBe("run-xyz");
  });

  it("refuses local-runtime org BYOK + requireToolApproval=true with non-empty tools (no auto-deny loop on the local path yet)", async () => {
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
    ).rejects.toThrow(
      /approval-required tool calls.*Disable tool approval/i,
    );

    // Refusal happens before the turn driver is invoked.
    expect(runLocalOrgChatTurnHeadlessMock).not.toHaveBeenCalled();
  });

  it("still dispatches local-runtime org BYOK when requireToolApproval is false", async () => {
    const calls: unknown[] = [];
    runLocalOrgChatTurnHeadlessMock.mockImplementation(
      buildLocalHeadlessStub(calls),
    );
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

    expect(runLocalOrgChatTurnHeadlessMock).toHaveBeenCalledTimes(1);
  });

  it("throws with a clear message when org-BYOK derivation fails (custom provider without a name)", async () => {
    // The resolver throws on deriveOrgProviderKey failure; runner propagates
    // the same message it threw before the refactor.
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
            // intentionally no customProviderName — forces deriveOrgProviderKey error
          } as ModelDefinition,
        }) as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/derive org provider key/i);
  });
});

describe("drainAssistantTurn — engine error surfacing", () => {
  beforeEach(() => {
    runAssistantTurnMock.mockReset();
    runLocalOrgChatTurnHeadlessMock.mockReset();
    resolveSyntheticModelSourceMock.mockReset();
  });

  it("throws when the engine reports an error and produces no turnTrace (spend-cap classification path)", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    runAssistantTurnMock.mockImplementation(async (opts: any) => {
      // streamSink: "none" contract — the engine never throws; it fires
      // onEngineError and returns without a turnTrace.
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
      drainAssistantTurn(
        baseArgs() as Parameters<typeof drainAssistantTurn>[0],
      ),
    ).rejects.toThrow(/spend cap.*spend_cap_exceeded.*HTTP 429/i);
  });

  it("throws when the engine returns no turnTrace even WITHOUT a captured engine error (no silent empty turns)", async () => {
    // Cursor Bugbot (PR 2610): a missing turnTrace on a non-aborted turn
    // always means runSucceeded=false — engine-internal aborts or error
    // sites the onEngineError callback doesn't cover must still fail the
    // session instead of silently recording an empty assistant reply.
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    runAssistantTurnMock.mockImplementation(async (opts: any) => ({
      messages: opts.messages,
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
      // no turnTrace, no onEngineError fired
    }));

    await expect(
      drainAssistantTurn(
        baseArgs() as Parameters<typeof drainAssistantTurn>[0],
      ),
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

  it("threads turn hooks into the engine call (browser session context attachment)", async () => {
    const calls: unknown[] = [];
    runAssistantTurnMock.mockImplementation(buildEngineStub(calls));
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

  it("threads local-branch hooks into runLocalOrgChatTurnHeadless", async () => {
    const calls: unknown[] = [];
    runLocalOrgChatTurnHeadlessMock.mockImplementation(
      buildLocalHeadlessStub(calls),
    );
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
    expect(opts.onToolResultChunk).toBe(onToolResultChunk);
  });
});
