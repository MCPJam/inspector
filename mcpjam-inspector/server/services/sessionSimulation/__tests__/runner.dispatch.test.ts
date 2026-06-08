import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelDefinition } from "@/shared/types";

const handleMCPJamFreeChatModelMock = vi.fn();
const handleHostedOrgChatModelMock = vi.fn();
const handleLocalOrgChatModelMock = vi.fn();
const resolveOrgProviderRuntimeMock = vi.fn();

vi.mock("../../../utils/mcpjam-stream-handler.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcpjam-stream-handler.js")
  >("../../../utils/mcpjam-stream-handler.js");
  return {
    ...actual,
    handleMCPJamFreeChatModel: (...args: unknown[]) =>
      handleMCPJamFreeChatModelMock(...args),
  };
});

vi.mock("../../../utils/org-model-stream-handler.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-stream-handler.js")
  >("../../../utils/org-model-stream-handler.js");
  return {
    ...actual,
    handleHostedOrgChatModel: (...args: unknown[]) =>
      handleHostedOrgChatModelMock(...args),
    handleLocalOrgChatModel: (...args: unknown[]) =>
      handleLocalOrgChatModelMock(...args),
  };
});

vi.mock("../../../utils/org-model-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-config.js")
  >("../../../utils/org-model-config.js");
  return {
    ...actual,
    resolveOrgProviderRuntime: (...args: unknown[]) =>
      resolveOrgProviderRuntimeMock(...args),
  };
});

import { drainAssistantTurn } from "../runner.js";

/**
 * The runner's drainAssistantTurn awaits handler responses and then reads
 * `response.body` to drain the SSE stream before returning. The handler
 * also fires `onConversationComplete` synchronously inside the handler
 * (in production via the AI SDK stream's onFinish). For dispatch tests we
 * return an empty Response and invoke onConversationComplete before
 * returning so the captured history flows through.
 */
function buildHandlerStub(captureCalls: unknown[]) {
  return vi.fn(async (opts: any) => {
    captureCalls.push(opts);
    // Synchronously invoke onConversationComplete with a captured history
    // so the runner has something to return.
    opts.onConversationComplete?.(opts.messages, {
      turnId: "test-turn",
      promptIndex: 0,
      startedAt: 0,
      endedAt: 0,
      spans: [],
    });
    return new Response(null, { status: 200 });
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
    handleMCPJamFreeChatModelMock.mockReset();
    handleHostedOrgChatModelMock.mockReset();
    handleLocalOrgChatModelMock.mockReset();
    resolveOrgProviderRuntimeMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches MCPJam-provided models through handleMCPJamFreeChatModel and threads synthesisRunId via extraBodyFields", async () => {
    const calls: unknown[] = [];
    handleMCPJamFreeChatModelMock.mockImplementation(buildHandlerStub(calls));

    const result = await drainAssistantTurn(
      baseArgs() as Parameters<typeof drainAssistantTurn>[0],
    );

    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledTimes(1);
    expect(handleHostedOrgChatModelMock).not.toHaveBeenCalled();
    expect(handleLocalOrgChatModelMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("mcpjam");
    const opts = calls[0] as any;
    expect(opts.extraBodyFields).toMatchObject({ synthesisRunId: "run-xyz" });
    expect(opts.approvalMode).toBe("auto-deny");
  });

  it("dispatches non-MCPJam models with cloud runtime through handleHostedOrgChatModel and threads synthesisRunId via extraBodyFields", async () => {
    const calls: unknown[] = [];
    handleHostedOrgChatModelMock.mockImplementation(buildHandlerStub(calls));
    resolveOrgProviderRuntimeMock.mockResolvedValue({
      runtimeLocation: "cloud",
      providerKey: "anthropic",
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

    expect(handleHostedOrgChatModelMock).toHaveBeenCalledTimes(1);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    expect(handleLocalOrgChatModelMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("byok");
    const opts = calls[0] as any;
    expect(opts.extraBodyFields).toMatchObject({ synthesisRunId: "run-xyz" });
    expect(opts.providerKey).toBe("anthropic");
    // Synthetic runs must auto-deny approval-required tool calls — there
    // is no human in the loop. Regression guard for #2486 PR review.
    expect(opts.approvalMode).toBe("auto-deny");
  });

  it("dispatches non-MCPJam models with local runtime through handleLocalOrgChatModel and threads synthesisRunId as a typed option", async () => {
    const calls: unknown[] = [];
    handleLocalOrgChatModelMock.mockImplementation(buildHandlerStub(calls));
    resolveOrgProviderRuntimeMock.mockResolvedValue({
      runtimeLocation: "local",
      provider: {
        providerKey: "openai",
        // local providers carry resolved config including apiKey
      } as any,
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

    expect(handleLocalOrgChatModelMock).toHaveBeenCalledTimes(1);
    expect(handleHostedOrgChatModelMock).not.toHaveBeenCalled();
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    expect(result.modelSource).toBe("local_byok");
    const opts = calls[0] as any;
    expect(opts.synthesisRunId).toBe("run-xyz");
  });

  it("throws with a clear message when org-BYOK derivation fails (custom provider without a name)", async () => {
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
