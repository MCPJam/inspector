/**
 * A browser Playground turn must RECORD THE TARGET IT RAN ON.
 *
 * Before this, the direct-chat `resumeConfig` carried seven fields and not one
 * of them said where the turn executed. Reopening a conversation therefore had
 * nothing to restore from, and the client fell back to the viewer's own
 * localStorage selections — a conversation that ran on a Cursor harness in a
 * Project Environment reopened displaying an unrelated host and model, and a
 * follow-up typed into it ran on that unrelated target silently. Only
 * `origin: "api"` sessions (`routes/v1/chat-session-turn.ts`) wrote the pin.
 *
 * These tests lock the persisted PAYLOAD, not the client's restore behaviour:
 * they assert on the `persistChatSessionToConvex` call the turn makes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed with an explicit parameter so `mock.calls[0][0]` is the recorded
// argument rather than an empty tuple — these tests exist to read it.
const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async (_opts: unknown) => new Response("mcpjam")),
  hostedOrg: vi.fn(async (_opts: unknown) => new Response("org-hosted")),
  localOrg: vi.fn(async (_opts: unknown) => new Response("org-local")),
}));

const persistMock = vi.hoisted(() =>
  vi.fn(async (_payload: unknown) => ({ outcome: "ok" as const })),
);

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

// Only the writer is replaced — everything else this module exports (the
// enrichment header picker, the sender-id stamper) still runs for real, so the
// payload under assertion is the one the turn actually builds.
vi.mock("../chat-ingestion.js", async () => {
  const actual = await vi.importActual<typeof import("../chat-ingestion.js")>(
    "../chat-ingestion.js",
  );
  return { ...actual, persistChatSessionToConvex: persistMock };
});

import { streamWebChatTurn } from "../web-chat-turn";

function args(persistOverrides: Record<string, unknown>) {
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
        id: "gpt-5-nano",
        provider: "openai",
        name: "m",
      } as never,
      uiMessages: [],
    },
    persist: {
      // A hosted session id is what makes the turn build an
      // `onConversationComplete` at all.
      chatSessionId: "cs-playground-1",
      projectId: "p1",
      sourceType: "direct" as const,
      origin: "playground" as const,
      originalMessages: [],
      selectedServerIds: [],
      harness: "claude-code" as const,
      // Presence (even empty) means "already resolved" — keeps the turn from
      // reaching for the runtime-secrets endpoint in a unit test.
      runtimeSecrets: [],
      ...persistOverrides,
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c,
    },
  };
}

/** Run one turn and return the `resumeConfig` it persisted. */
async function persistedResumeConfig(
  persistOverrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await streamWebChatTurn(args(persistOverrides) as never);
  const opts = handlers.mcpjamFree.mock.calls[0]?.[0] as
    | {
        onConversationComplete?: (
          history: unknown[],
          trace: unknown,
        ) => Promise<unknown>;
      }
    | undefined;
  expect(opts?.onConversationComplete).toBeTypeOf("function");
  await opts!.onConversationComplete!([], { turnId: "t1" });
  const payload = persistMock.mock.calls[0]?.[0] as
    { resumeConfig?: Record<string, unknown> } | undefined;
  expect(payload?.resumeConfig).toBeDefined();
  return payload!.resumeConfig!;
}

describe("browser Playground turn records its execution target", () => {
  beforeEach(() => {
    handlers.mcpjamFree.mockClear();
    handlers.hostedOrg.mockClear();
    handlers.localOrg.mockClear();
    persistMock.mockClear();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
  });

  it("persists the environment it ran in as a resume pin", async () => {
    const resumeConfig = await persistedResumeConfig({
      environmentId: "env_abc123",
    });
    expect(resumeConfig.environmentId).toBe("env_abc123");
  });

  it("persists NOTHING rather than a placeholder when the turn had no target", async () => {
    const resumeConfig = await persistedResumeConfig({});
    // Absent, not `undefined`/`null`/`""`. A recorded empty value would read as
    // "we know, and it was nothing" — the false certainty the client's
    // "as-run configuration unavailable" disclosure exists to avoid.
    expect("environmentId" in resumeConfig).toBe(false);
  });

  it("treats an empty environment id as no target, not as a pin", async () => {
    const resumeConfig = await persistedResumeConfig({ environmentId: "" });
    expect("environmentId" in resumeConfig).toBe(false);
  });

  it("re-sends the pin on a continuation instead of pinning locally", async () => {
    // The inspector deliberately does NOT try to enforce first-write-wins
    // itself: `preserveAgentResumePins` does that at the ingest boundary, so a
    // continuation carrying a different environment cannot rewrite what the
    // conversation already recorded. Sending it every turn is what lets a
    // session created before this field existed get filled in on its next turn
    // rather than staying unpinned forever — the same reasoning the v1 agent
    // route already documents for its four pins.
    const resumeConfig = await persistedResumeConfig({
      environmentId: "env_second_turn",
    });
    expect(resumeConfig.environmentId).toBe("env_second_turn");
  });

  it("leaves the other resume fields untouched", async () => {
    const resumeConfig = await persistedResumeConfig({
      environmentId: "env_abc123",
      systemPrompt: "be helpful",
      requireToolApproval: true,
    });
    expect(resumeConfig.systemPrompt).toBe("be helpful");
    expect(resumeConfig.requireToolApproval).toBe(true);
    expect(resumeConfig.selectedServers).toEqual([]);
  });
});
