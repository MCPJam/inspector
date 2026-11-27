/**
 * A Playground event turn on the web chat path: the event the route checked
 * reaches the engine (which echoes it on the live `turn_start`) and is written
 * on the turn trace sent to ingest. A turn no event started carries neither.
 *
 * Same mocked-handler shape as `web-chat-turn-page-tools.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventAtTurn } from "@/shared/event-at-turn";

interface HandlerOptions {
  eventAtTurn?: EventAtTurn;
  onConversationComplete?: (
    history: unknown[],
    turnTrace: Record<string, unknown>,
  ) => Promise<unknown>;
}

const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async (_options: HandlerOptions) => new Response("mcpjam")),
}));

vi.mock("../mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handlers.mcpjamFree,
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
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
  buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
}));

vi.mock("../mcp-tool-result-model-output.js", () => ({
  convertToMcpjamModelMessages: vi.fn(async () => []),
}));

const persistChatSessionToConvex = vi.hoisted(() =>
  vi.fn(async (_options: { turnTrace?: Record<string, unknown> }) => ({
    outcome: "saved" as const,
    version: 1,
  })),
);
vi.mock("../chat-ingestion.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-ingestion")>("../chat-ingestion");
  return { ...actual, persistChatSessionToConvex };
});

import { streamWebChatTurn } from "../web-chat-turn";

const EVENT: EventAtTurn = {
  name: "comment.created",
  eventId: "evt_1",
  receivedAt: 1_700_000_000_000,
  delivery: "push",
  origin: "server",
  subscriptionId: "esub_1",
};

function args(eventAtTurn?: EventAtTurn) {
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
    },
    persist: {
      chatSessionId: "chat-1",
      projectId: "p1",
      sourceType: "direct" as const,
      origin: "playground" as const,
      originalMessages: [],
      selectedServerIds: [],
      captureToolSnapshot: false,
      ...(eventAtTurn ? { eventAtTurn } : {}),
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c,
    },
  };
}

const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 1,
  endedAt: 2,
  spans: [],
  modelId: "gpt-5-nano",
};

describe("streamWebChatTurn: the event that started the turn", () => {
  beforeEach(() => {
    handlers.mcpjamFree.mockClear();
    persistChatSessionToConvex.mockClear();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hands the event to the engine for the live turn_start", async () => {
    await streamWebChatTurn(args(EVENT) as never);
    expect(handlers.mcpjamFree.mock.calls[0]?.[0]?.eventAtTurn).toEqual(EVENT);
  });

  it("writes the event on the turn trace it persists", async () => {
    await streamWebChatTurn(args(EVENT) as never);
    const complete = handlers.mcpjamFree.mock.calls[0]?.[0]?.onConversationComplete;
    expect(complete).toBeTypeOf("function");
    await complete!([], { ...TURN_TRACE });
    expect(persistChatSessionToConvex.mock.calls[0]?.[0]?.turnTrace).toMatchObject({
      turnId: "turn-1",
      eventAtTurn: EVENT,
    });
  });

  it("leaves a turn no event started without one", async () => {
    await streamWebChatTurn(args() as never);
    const options = handlers.mcpjamFree.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("eventAtTurn");
    await options!.onConversationComplete!([], { ...TURN_TRACE });
    expect(persistChatSessionToConvex.mock.calls[0]?.[0]?.turnTrace).not.toHaveProperty(
      "eventAtTurn",
    );
  });
});
