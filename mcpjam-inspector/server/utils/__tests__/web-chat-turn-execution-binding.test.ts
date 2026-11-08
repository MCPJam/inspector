/**
 * The route starts a continuing conversation's execution-binding check while
 * it prepares tools; the stream preparation must await THAT check (not issue a
 * second one) and fail the turn with its error exactly where the serial check
 * used to. Same mocked-handler shape as `web-chat-turn-page-tools.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async () => new Response("mcpjam")),
  assertExecution: vi.fn(async () => {}),
}));

vi.mock("../mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: m.mcpjamFree,
  warnIfChatAbortSignalMissing: vi.fn(),
}));
vi.mock("../org-model-stream-handler.js", () => ({
  resolveLocalOrgMaxSteps: () => 30,
  handleHostedOrgChatModel: vi.fn(),
  handleLocalOrgChatModel: vi.fn(),
}));
vi.mock("../org-model-config.js", () => ({
  deriveOrgProviderKey: vi.fn(() => ({ ok: true, key: "openai" })),
  isLocalRuntimeEligible: vi.fn(() => false),
  resolveOrgProviderRuntime: vi.fn(),
}));
vi.mock("../chat-v2-orchestration.js", () => ({
  prepareChatV2: vi.fn(async () => ({
    allTools: {},
    enhancedSystemPrompt: "",
    resolvedTemperature: undefined,
    scrubMessages: (messages: unknown[]) => messages,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
  buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
}));
vi.mock("../mcp-tool-result-model-output.js", () => ({
  convertToMcpjamModelMessages: vi.fn(async () => []),
}));
vi.mock("../harness/conversation-execution.js", () => ({
  assertConversationExecution: m.assertExecution,
}));

import { streamWebChatTurn } from "../web-chat-turn";
import { startEarly } from "../early-start";

function args(runtime: Record<string, unknown> = {}) {
  return {
    manager: {
      disconnectAllServers: vi.fn(async () => {}),
      hasServer: () => false,
    } as never,
    prepare: {
      selectedServerIds: [],
      modelDefinition: {
        name: "m",
        id: "gpt-5-nano",
        provider: "openai",
      } as never,
      uiMessages: [],
    },
    persist: {
      chatSessionId: "chat-1",
      projectId: "p1",
      sourceType: "direct" as const,
      origin: "playground" as const,
      originalMessages: [],
      selectedServerIds: [],
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c: {
        req: {
          raw: { headers: new Headers(), signal: undefined },
          header: () => undefined,
        },
      } as never,
      ...runtime,
    },
  };
}

describe("streamWebChatTurn — execution binding", () => {
  beforeEach(() => {
    m.mcpjamFree.mockClear();
    m.assertExecution.mockClear();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("awaits the check the route already started instead of a second one", async () => {
    const started = vi.fn(async () => {});
    await streamWebChatTurn(
      args({ executionBinding: startEarly(started) }) as never,
    );
    expect(started).toHaveBeenCalledTimes(1);
    expect(m.assertExecution).not.toHaveBeenCalled();
    expect(m.mcpjamFree).toHaveBeenCalledTimes(1);
  });

  it("fails the turn with the started check's refusal before the engine runs", async () => {
    const refusal = new Error(
      "This conversation cannot continue with the selected runtime. Start a new chat.",
    );
    await expect(
      streamWebChatTurn(
        args({
          executionBinding: startEarly(async () => {
            throw refusal;
          }),
        }) as never,
      ),
    ).rejects.toBe(refusal);
    expect(m.mcpjamFree).not.toHaveBeenCalled();
  });

  it("checks the binding itself when the route started nothing", async () => {
    await streamWebChatTurn(args() as never);
    expect(m.assertExecution).toHaveBeenCalledTimes(1);
    expect(m.mcpjamFree).toHaveBeenCalledTimes(1);
  });
});
