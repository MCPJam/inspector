/**
 * Dispatch regression for `streamWebChatTurn`: the MCPJam-vs-org-BYOK branch
 * must canonicalize the model id WITH the provider, exactly like the route's
 * harness preflight does. Before the fix, a bare hosted id (`gpt-5-nano` +
 * `openai`) passed the preflight (which supplies the provider) but the
 * dispatch recomputed `isMCPJam` provider-blind — so the turn silently
 * branched into org-BYOK handling and skipped `runHarnessTurn` even though
 * `persist.harness` was set.
 *
 * The stream handlers are mocked; these are pure dispatch tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async () => new Response("mcpjam")),
  hostedOrg: vi.fn(async () => new Response("org-hosted")),
  localOrg: vi.fn(async () => new Response("org-local")),
}));

vi.mock("../mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handlers.mcpjamFree,
  warnIfChatAbortSignalMissing: vi.fn(),
}));

vi.mock("../org-model-stream-handler.js", () => ({
  handleHostedOrgChatModel: handlers.hostedOrg,
  handleLocalOrgChatModel: handlers.localOrg,
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
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
  buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
}));

vi.mock("../mcp-tool-result-model-output.js", () => ({
  convertToMcpjamModelMessages: vi.fn(async () => []),
}));

vi.mock("../harness/harness-proxy-strategy.js", () => ({
  resolveWebAuthorizedHarnessStrategy: vi.fn(() => ({
    plane: "web-authorized",
    mode: "direct",
    publicBaseUrl: "https://inspector.example.com",
  })),
}));

import { streamWebChatTurn } from "../web-chat-turn";

function args(modelDefinition: {
  id: string;
  provider: string;
  name?: string;
}) {
  const c = {
    req: {
      raw: { headers: new Headers(), signal: undefined },
      header: () => undefined,
    },
  } as never;
  return {
    manager: {
      disconnectAllServers: vi.fn(async () => {}),
      hasServer: () => false,
    } as never,
    prepare: {
      selectedServerIds: [],
      modelDefinition: { name: "m", ...modelDefinition } as never,
      uiMessages: [],
    },
    persist: {
      chatSessionId: undefined,
      projectId: "p1",
      sourceType: "direct" as const,
      origin: "playground" as const,
      originalMessages: [],
      selectedServerIds: [],
      harness: "claude-code" as const,
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c,
    },
  };
}

describe("streamWebChatTurn model dispatch", () => {
  beforeEach(() => {
    handlers.mcpjamFree.mockClear();
    handlers.hostedOrg.mockClear();
    handlers.localOrg.mockClear();
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  });

  it("routes a BARE MCPJam-hosted id + provider to the MCPJam path (harness runs)", async () => {
    await streamWebChatTurn(
      args({ id: "gpt-5-nano", provider: "openai" }) as never,
    );
    expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
    expect(handlers.hostedOrg).not.toHaveBeenCalled();
    const opts = handlers.mcpjamFree.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(opts.harness).toBe("claude-code");
  });

  it("routes a prefixed MCPJam id to the MCPJam path (sanity)", async () => {
    await streamWebChatTurn(
      args({ id: "openai/gpt-5-nano", provider: "openai" }) as never,
    );
    expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
    expect(handlers.hostedOrg).not.toHaveBeenCalled();
  });

  it("routes a non-MCPJam model to the org-BYOK path", async () => {
    await streamWebChatTurn(
      args({ id: "gpt-4.1-mini-custom", provider: "openai" }) as never,
    );
    expect(handlers.hostedOrg).toHaveBeenCalledTimes(1);
    expect(handlers.mcpjamFree).not.toHaveBeenCalled();
  });
});
