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

// A real `PersistChatOutcome`, not a stub token: the continuation case below
// takes its `expectedVersion` from the version the previous turn's save
// returned, which is how the client builds one.
const persistMock = vi.hoisted(() =>
  vi.fn(async (_payload: unknown) => ({
    outcome: "saved" as const,
    version: 7,
  })),
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

type PersistCallback = (history: unknown[], trace: unknown) => Promise<unknown>;

/**
 * Run one turn and hand back the persist callback it built, undriven.
 *
 * Reads the NEWEST handler call rather than the first, so a test can run a
 * second turn on top of a first — which is what an honest continuation needs.
 */
async function startTurn(
  persistOverrides: Record<string, unknown>,
): Promise<PersistCallback> {
  await streamWebChatTurn(args(persistOverrides) as never);
  const opts = handlers.mcpjamFree.mock.calls.at(-1)?.[0] as
    { onConversationComplete?: PersistCallback } | undefined;
  expect(opts?.onConversationComplete).toBeTypeOf("function");
  return opts!.onConversationComplete!;
}

/** Run one turn, drive its persist, and return the payload it wrote. */
async function persistOneTurn(
  persistOverrides: Record<string, unknown>,
  fullHistory: unknown[] = [],
): Promise<Record<string, unknown>> {
  const before = persistMock.mock.calls.length;
  const onConversationComplete = await startTurn(persistOverrides);
  await onConversationComplete(fullHistory, { turnId: "t1" });
  // One turn wrote exactly one record — this keeps the `.at(-1)` reads from
  // silently reporting on some earlier turn's payload.
  expect(persistMock.mock.calls.length).toBe(before + 1);
  return persistMock.mock.calls.at(-1)![0] as Record<string, unknown>;
}

/** The outcome the most recent persist resolved with. */
async function lastPersistOutcome(): Promise<{ version?: number }> {
  return (await persistMock.mock.results.at(-1)!.value) as { version?: number };
}

function resumeConfigOf(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  expect(payload.resumeConfig).toBeDefined();
  return payload.resumeConfig as Record<string, unknown>;
}

/** Run one turn and return the `resumeConfig` it persisted. */
async function persistedResumeConfig(
  persistOverrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return resumeConfigOf(await persistOneTurn(persistOverrides));
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

  it("treats a null environment id as no target, not as a pin", async () => {
    // Same rule as `""`, one rung lower: only a truthy id is a target. A
    // `persist.environmentId !== undefined` gate would write `null` here, and
    // a recorded null is a recorded answer.
    const resumeConfig = await persistedResumeConfig({ environmentId: null });
    expect("environmentId" in resumeConfig).toBe(false);
  });

  it("re-sends the pin on a REAL continuation instead of pinning locally", async () => {
    // TURN 1 — a fresh conversation. This is what creates the already-pinned
    // session the second turn continues from; without it the assertion below
    // would just be the first test again.
    const first = await persistOneTurn({ environmentId: "env_first_turn" });
    expect(resumeConfigOf(first).environmentId).toBe("env_first_turn");
    const savedVersion = (await lastPersistOutcome()).version;
    expect(savedVersion).toBeTypeOf("number");

    // TURN 2 — an ACTUAL continuation of that session: the same chat session
    // id, the first exchange replayed back in, and the CAS baseline the client
    // took from turn 1's save. And it ran somewhere ELSE, which is the only
    // arrangement that can tell the three candidate behaviours apart.
    const prior = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ];
    const second = await persistOneTurn(
      {
        environmentId: "env_second_turn",
        originalMessages: prior,
        expectedVersion: savedVersion,
      },
      prior,
    );

    // The continuation state really reached the writer. If these ever stopped
    // holding, the assertion below would be proving nothing about a
    // continuation — it would be a duplicate of the first test wearing a
    // different name, which is what this test replaced.
    expect(second.chatSessionId).toBe(first.chatSessionId);
    expect(second.expectedVersion).toBe(savedVersion);
    expect((second.sessionMessages as unknown[]).length).toBe(prior.length);

    // THE POINT. The second turn still records what IT ran on:
    //   - not absent  (a "the session already has a pin, skip it" local gate),
    //   - not `env_first_turn`  (a local first-write-wins replay).
    // First-write-wins is `preserveAgentResumePins`'s job at the ingest
    // boundary, not this process's. Sending unconditionally is also the only
    // way a session created before this field existed ever acquires one.
    expect(resumeConfigOf(second).environmentId).toBe("env_second_turn");
  });

  it("propagates a rejected persist to the engine rather than swallowing it", async () => {
    // `onConversationComplete`'s result becomes the turn's
    // `data-persist-receipt`, so the client is TOLD what happened to its save.
    // A swallowed rejection would resolve as "nothing to report" and the
    // conversation would look saved when it was not.
    const onConversationComplete = await startTurn({
      environmentId: "env_abc123",
    });
    persistMock.mockRejectedValueOnce(new Error("ingest exploded"));
    await expect(
      onConversationComplete([], { turnId: "t1" }),
    ).rejects.toThrowError("ingest exploded");
    expect(persistMock).toHaveBeenCalledTimes(1);
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
