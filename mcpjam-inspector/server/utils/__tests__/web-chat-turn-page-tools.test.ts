/**
 * Page tools on the HOSTED turn.
 *
 * `/api/web/chat-v2` used to ignore `pageTools` entirely, so the Playground's
 * "Page tools" opt-in was local-only: a hosted turn that advertised them would
 * have dropped every call. Two things have to be true for it to work, and both
 * are asserted here because neither is visible from the other side —
 *
 *  1. the entries reach `prepareChatV2`, which is what turns them into tools
 *     the model can see at all;
 *  2. the tools it builds reach the engine still carrying their approval
 *     declaration. A page tool that arrives without one strands the turn: the
 *     client defers the call and waits for a pill the server never sends.
 *
 * The second one used to be a separate name set the route had to remember to
 * thread. It is now a property of the tool, so this asserts it where the
 * engine actually reads it — on the ToolSet the route hands over — with the
 * REAL builder behind the mocked `prepareChatV2`.
 *
 * Same mocked-handler shape as `web-chat-turn-dispatch.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface HandlerOptions {
  tools?: Record<string, { needsApproval?: unknown }>;
}

const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async (_options: HandlerOptions) => new Response("mcpjam")),
  hostedOrg: vi.fn(async (_options: HandlerOptions) => new Response("org")),
  localOrg: vi.fn(async (_options: HandlerOptions) => new Response("local")),
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

const prepareChatV2 = vi.hoisted(() =>
  vi.fn(async (_args: { pageTools?: unknown }) => ({
    allTools: {} as Record<string, unknown>,
    enhancedSystemPrompt: "",
    resolvedTemperature: undefined,
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
);

vi.mock("../chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../chat-v2-orchestration")
  >("../chat-v2-orchestration");
  // The REAL page-tool builder behind the mock, so what the engine is handed
  // here is what production hands it — declaration included. A stub returning
  // `{}` would pass this file while the turn stranded in production.
  prepareChatV2.mockImplementation(async (args: { pageTools?: unknown }) => ({
    allTools: actual.buildPageTools(args.pageTools as never) as Record<
      string,
      unknown
    >,
    enhancedSystemPrompt: "",
    resolvedTemperature: undefined,
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  }));
  return {
    prepareChatV2,
    buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
  };
});

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

const PAGE_TOOL = {
  alias: "page_1a2b3c4d",
  rawName: "bookSlot",
  toolKey: "bookSlot",
  origin: "https://example.test",
  description: "Book a slot",
  inputSchema: { type: "object" as const, properties: {} },
};

function args(pageTools?: unknown[]) {
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
      modelDefinition: {
        name: "m",
        id: "gpt-5-nano",
        provider: "openai",
      } as never,
      uiMessages: [],
      ...(pageTools ? { pageTools } : {}),
    },
    persist: {
      chatSessionId: undefined,
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
      c,
    },
  };
}

describe("streamWebChatTurn — WebMCP page tools", () => {
  beforeEach(() => {
    handlers.mcpjamFree.mockClear();
    prepareChatV2.mockClear();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hands the page tools to prepareChatV2", async () => {
    await streamWebChatTurn(args([PAGE_TOOL]) as never);
    expect(prepareChatV2.mock.calls[0]?.[0]?.pageTools).toEqual([PAGE_TOOL]);
  });

  it("gates every page alias, so the turn cannot strand on a missing pill", async () => {
    await streamWebChatTurn(args([PAGE_TOOL]) as never);
    const tools = handlers.mcpjamFree.mock.calls[0]?.[0]?.tools;
    expect(tools?.page_1a2b3c4d?.needsApproval).toBe(true);
  });

  it("leaves a turn with no page tools exactly as it was", async () => {
    await streamWebChatTurn(args() as never);
    expect(prepareChatV2.mock.calls[0]?.[0]?.pageTools).toBeUndefined();
    expect(handlers.mcpjamFree.mock.calls[0]?.[0]?.tools).toEqual({});
  });
});
