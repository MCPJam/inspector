/**
 * runner.browser.test.ts — browser-rendered MCP App pipeline wiring in the
 * shared synthetic-session core (`runSyntheticHostSession`).
 *
 * Locks the per-session browser-context lifecycle (create → per-turn
 * setActivePromptIndex + dismissCarriedWidget → dispose-on-every-exit), the
 * Computer Use tool merge + hook threading into `drainAssistantTurn`, the
 * per-turn artifact drain surfaced to `onTurnPersisted`, Cloud Skills wiring,
 * and failure classification. This is the core the swarm runner executes every
 * attempt through, so these are swarm-critical guarantees.
 *
 * Drives the core directly (the scenario batch loop that used to wrap it is
 * gone). Two side-persistence paths are exercised here: the widget-snapshot
 * capture the surface injects via `onTurnPersisted`, and the browser-artifact
 * outbox the core drives itself (`browserArtifacts`) — the latter because its
 * capture-before-teardown ordering is only correct if the CORE owns it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAssistantTurnMock = vi.fn();
const resolveSyntheticModelSourceMock = vi.fn();
const persistChatSessionToConvexMock = vi.fn();
const captureMcpAppWidgetSnapshotsMock = vi.fn();
const prepareChatV2Mock = vi.fn();
const convexMutationMock = vi.fn();
const createBrowserSessionContextMock = vi.fn();
const listCloudRuntimeSkillsMock = vi.fn();

// The project catalog is the one skills dependency the runner reaches out to
// itself; everything else about the skill surface is the orchestrator's, and
// `prepareChatV2` is mocked here.
vi.mock("../../../utils/computers/cloud-skill-tools.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >("../../../utils/computers/cloud-skill-tools.js");
  return {
    ...actual,
    listCloudRuntimeSkills: (...args: unknown[]) =>
      listCloudRuntimeSkillsMock(...args),
  };
});

vi.mock("../../../utils/assistant-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/assistant-turn.js")
  >("../../../utils/assistant-turn.js");
  return {
    ...actual,
    runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
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

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: (...args: unknown[]) =>
      persistChatSessionToConvexMock(...args),
  };
});

vi.mock("../../../utils/mcp-app-widget-capture.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcp-app-widget-capture.js")
  >("../../../utils/mcp-app-widget-capture.js");
  return {
    ...actual,
    captureMcpAppWidgetSnapshots: (...args: unknown[]) =>
      captureMcpAppWidgetSnapshotsMock(...args),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return {
    ...actual,
    prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
  };
});

vi.mock("../../browser-session-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../browser-session-context.js")
  >("../../browser-session-context.js");
  return {
    ...actual,
    createBrowserSessionContext: (...args: unknown[]) =>
      createBrowserSessionContextMock(...args),
  };
});

vi.mock("convex/browser", async () => {
  const actual = await vi.importActual<typeof import("convex/browser")>(
    "convex/browser"
  );
  return {
    ...actual,
    ConvexHttpClient: class {
      setAuth() {}
      mutation(...args: unknown[]) {
        return convexMutationMock(...args);
      }
    },
  };
});

import { runSyntheticHostSession } from "../runner.js";

const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans: [],
};

/** Ordered call log shared by the fake browser context + engine mock. */
let callOrder: string[] = [];

function buildFakeBrowserContext(opts: { computerUse: boolean }) {
  const artifacts: {
    observations: Array<Record<string, unknown>>;
    steps: Array<Record<string, unknown>>;
  } = { observations: [], steps: [] };
  const ctx = {
    computerUseSupported: opts.computerUse,
    computerUseVersion: opts.computerUse ? ("20250124" as const) : null,
    computerWidgetTools: opts.computerUse
      ? { computer: { fake: true }, finish_widget: { fake: true } }
      : {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: opts.computerUse ? vi.fn() : undefined,
    setActivePromptIndex: vi.fn((i: number) => {
      callOrder.push(`setActivePromptIndex:${i}`);
    }),
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(),
    handleDirectToolResultChunk: vi.fn(),
    drainNewArtifacts: vi.fn(() => {
      const out = {
        observations: artifacts.observations,
        steps: artifacts.steps,
      };
      artifacts.observations = [];
      artifacts.steps = [];
      return out;
    }),
    collectVideo: vi.fn(async (): Promise<Buffer | null> => {
      callOrder.push("collectVideo");
      return null;
    }),
    dismissCarriedWidget: vi.fn(async () => {
      callOrder.push("dismissCarriedWidget");
    }),
    dispose: vi.fn(async () => {
      callOrder.push("dispose");
    }),
    /** Test handle: queue artifacts the next drain returns. */
    _queueArtifacts(
      observations: Array<Record<string, unknown>>,
      steps: Array<Record<string, unknown>>
    ) {
      artifacts.observations = observations;
      artifacts.steps = steps;
    },
  };
  return ctx;
}

/** Records what `onTurnPersisted` saw, mirroring the swarm surface's hook. */
let turnPersistedCalls: Array<{ promptIndex: number }> = [];

function baseAdapter(overrides?: {
  modelId?: string;
  runtime?: Record<string, unknown>;
  persist?: Record<string, unknown>;
  emit?: (payload: unknown) => void;
}) {
  return {
    runId: "run-1",
    projectId: "proj-1",
    chatSessionId: "synth_run-1_p1_0",
    maxTurns: 3,
    runtime: {
      modelDefinition: {
        id: overrides?.modelId ?? "anthropic/claude-haiku-4.5",
      } as never,
      systemPrompt: "system",
      requireToolApproval: false,
      ...(overrides?.runtime ?? {}),
    } as never,
    authHeader: "Bearer token",
    managerFactory: async () => ({
      manager: {
        hasServer: () => false,
        executeTool: vi.fn(),
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as never,
      connectedServerIds: ["server-1"],
      connectedServerNames: ["Server One"],
      dispose: async () => {},
    }),
    // One user turn, then the persona ends the session.
    nextPersonaTurn: vi
      .fn()
      .mockResolvedValueOnce({ message: "draw me a box", endSession: false })
      .mockResolvedValue({ message: "", endSession: true }),
    persist: {
      sourceType: "swarm" as const,
      origin: "swarm" as const,
      journeyRunId: "run-1",
      hostId: "host-1",
      personaId: "p1",
      personaLabel: "Persona One",
      ...(overrides?.persist ?? {}),
    },
    ...(overrides?.emit ? { emit: overrides.emit } : {}),
    onTurnPersisted: vi.fn(async (args: { promptIndex: number }) => {
      turnPersistedCalls.push({ promptIndex: args.promptIndex });
    }),
  };
}

beforeEach(() => {
  callOrder = [];
  turnPersistedCalls = [];
  vi.stubEnv("CONVEX_URL", "https://convex.cloud");
  runAssistantTurnMock.mockReset();
  resolveSyntheticModelSourceMock.mockReset();
  persistChatSessionToConvexMock
    .mockReset()
    .mockResolvedValue({ outcome: "saved", version: 1 });
  captureMcpAppWidgetSnapshotsMock.mockReset().mockResolvedValue([]);
  prepareChatV2Mock.mockReset().mockResolvedValue({
    allTools: { search: { description: "noop" } },
    enhancedSystemPrompt: "enhanced system",
    resolvedTemperature: undefined,
    progressivePlan: undefined,
    discoveryState: undefined,
  });
  convexMutationMock.mockReset().mockResolvedValue(null);
  createBrowserSessionContextMock.mockReset();
  listCloudRuntimeSkillsMock.mockReset().mockResolvedValue([
    {
      skillId: "skill-1",
      ref: "pdf-tools",
      name: "pdf-tools",
      description: "Process PDFs",
      aggregateHash: "hash-1",
      channels: [],
      content: async () => "# pdf-tools",
      files: [],
    },
  ]);
  resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
  runAssistantTurnMock.mockImplementation(async (opts: any) => {
    callOrder.push("runAssistantTurn");
    return {
      messages: [
        ...opts.messages,
        { role: "assistant", content: "drew a box" },
      ],
      assistantMessages: [],
      toolCalls: [],
      toolResults: [],
      turnTrace: TURN_TRACE,
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("runSyntheticHostSession — browser pipeline wiring", () => {
  it("creates one context per session, runs per-turn hygiene before the engine, merges computer tools, threads hooks, and disposes", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);

    const result = await runSyntheticHostSession(baseAdapter() as never);
    expect(result.outcome).toBe("succeeded");

    // Context per session, surface-scoped logging, Computer Use opted in.
    expect(createBrowserSessionContextMock).toHaveBeenCalledTimes(1);
    expect(createBrowserSessionContextMock.mock.calls[0]![0]).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      logScope: "sessionSimulation",
      enableComputerUse: true,
    });

    // Per-turn hygiene runs BEFORE the engine; dispose runs at session end.
    expect(callOrder).toEqual([
      "setActivePromptIndex:0",
      "dismissCarriedWidget",
      "runAssistantTurn",
      "dispose",
    ]);

    // Computer tools merged into the advertised set + hooks threaded.
    const engineOpts = runAssistantTurnMock.mock.calls[0]![0] as any;
    expect(Object.keys(engineOpts.tools).sort()).toEqual([
      "computer",
      "finish_widget",
      "search",
    ]);
    expect(engineOpts.prepareAdvertisedTools).toBe(fake.prepareAdvertisedTools);
    expect(typeof engineOpts.onToolCall).toBe("function");
    expect(typeof engineOpts.onToolResult).toBe("function");
    engineOpts.onToolCall({ toolCallId: "tc-1", input: { a: 1 } });
    expect(fake.noteToolCallInput).toHaveBeenCalledWith({
      toolCallId: "tc-1",
      input: { a: 1 },
    });

    // The turn persisted and the surface's per-turn side-persist hook fired
    // with the turn index (this is how the swarm captures widget snapshots).
    expect(persistChatSessionToConvexMock).toHaveBeenCalledTimes(1);
    expect(turnPersistedCalls).toEqual([{ promptIndex: 0 }]);
  });

  it("gives non-Claude drivers no computer tools", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);

    await runSyntheticHostSession(
      baseAdapter({ modelId: "openai/gpt-5-mini" }) as never
    );

    const engineOpts = runAssistantTurnMock.mock.calls[0]![0] as any;
    expect(Object.keys(engineOpts.tools)).toEqual(["search"]);
    expect(engineOpts.prepareAdvertisedTools).toBeUndefined();
  });

  it("passes computer resources to the built-in tool resolver (non-swarm surface)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);

    await runSyntheticHostSession(
      baseAdapter({
        runtime: {
          builtInToolIds: ["bash"],
          computer: { kind: "personal", workdir: "/workspace" },
          requireToolApproval: true,
        },
        // A hosted-scenario surface: bash is still resolved there. Swarm
        // sessions are the ones that fail closed — see the test below.
        persist: { sourceType: "scenario", origin: "scenario" },
      }) as never
    );

    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    expect(Object.keys(prepareOpts.builtInTools ?? {})).toEqual(["bash"]);
    expect(prepareOpts.builtInTools.bash).toBeDefined();
  });

  it("a swarm session gets no bash tool, and the run is told why", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);
    const emitted: any[] = [];

    await runSyntheticHostSession(
      baseAdapter({
        runtime: {
          builtInToolIds: ["bash"],
          computer: { kind: "personal", workdir: "/workspace" },
        },
        emit: (payload) => emitted.push(payload),
      }) as never
    );

    // Nothing advertised at all — the whole built-in set collapses to undefined
    // because bash was the only id, so no reserve is even reachable.
    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    expect(prepareOpts.builtInTools).toBeUndefined();

    const notice = emitted.find((p) => p.type === "session_notice");
    expect(notice).toMatchObject({ kind: "tool_suppressed", toolId: "bash" });
    expect(notice.message).toMatch(/simulated \(swarm\) sessions/);
  });

  it("wires Cloud Skills on the emulated synthetic path (member, no harness)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);

    await runSyntheticHostSession(baseAdapter() as never);

    expect(listCloudRuntimeSkillsMock).toHaveBeenCalledWith({
      authHeader: "Bearer token",
      projectId: "proj-1",
    });
    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    // The project pool arrives as a live capability set, and the source keeps
    // `composeLiveServerSkills` so a connected server's SEP-2640 skills compose
    // ON TOP of it rather than being displaced by it.
    expect(prepareOpts.skillsSource.kind).toBe("resolved");
    expect(prepareOpts.skillsSource.composeLiveServerSkills).toBe(true);
    expect(
      prepareOpts.skillsSource.capabilities.standaloneSkills.map(
        (skill: any) => skill.ref
      )
    ).toEqual(["pdf-tools"]);
  });

  it("omits Cloud Skills tools on the harness path (delivered natively)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);

    // claude-code + an MCPJam-provided model ⇒ the turn runs the real harness,
    // which writes skills into the sandbox itself; the emulated prompt catalog
    // + loadSkill tools must NOT also be advertised.
    await runSyntheticHostSession(
      baseAdapter({ runtime: { harness: "claude-code" } }) as never
    );

    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    expect(prepareOpts.skillsSource).toEqual({ kind: "none" });
    expect(listCloudRuntimeSkillsMock).not.toHaveBeenCalled();
  });

  it("omits Cloud Skills under tool approval (headless can't approve)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);

    // A synthetic visitor can't grant approval; the local-BYOK path fail-closes
    // on any non-empty tool set, so emulated skill tools must not be injected
    // when requireToolApproval is on (the skip stays correct even though
    // empty projects no longer advertise phantom tools).
    await runSyntheticHostSession(
      baseAdapter({ runtime: { requireToolApproval: true } }) as never
    );

    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    expect(prepareOpts.skillsSource).toEqual({ kind: "none" });
    expect(listCloudRuntimeSkillsMock).not.toHaveBeenCalled();
  });

  it("reports a catalog fetch failure, and still composes live server skills", async () => {
    const fake = buildFakeBrowserContext({ computerUse: false });
    createBrowserSessionContextMock.mockReturnValue(fake);
    listCloudRuntimeSkillsMock.mockRejectedValue(
      new Error("CONVEX_URL is not configured")
    );
    const emitted: any[] = [];

    await runSyntheticHostSession(
      baseAdapter({ emit: (payload) => emitted.push(payload) }) as never
    );

    const notice = emitted.find((p) => p.type === "session_notice");
    expect(notice).toMatchObject({
      kind: "tool_suppressed",
      toolId: "skills",
      message: "CONVEX_URL is not configured",
    });

    // The regression this pins: a failed PROJECT catalog must not collapse the
    // source to `{ kind: "none" }`. That would drop `composeLiveServerSkills`
    // and take the connected servers' skills down with it — skills that were
    // never fetched from Convex and never failed.
    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0] as any;
    expect(prepareOpts.skillsSource.kind).toBe("resolved");
    expect(prepareOpts.skillsSource.composeLiveServerSkills).toBe(true);
    expect(prepareOpts.skillsSource.capabilities.standaloneSkills).toEqual([]);
  });

  it("disposes the context when the turn throws, and reports failed", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);
    runAssistantTurnMock.mockRejectedValue(new Error("provider exploded"));

    // The core never throws — it classifies and returns.
    const result = await runSyntheticHostSession(baseAdapter() as never);

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("failed");
  });

  it("routes a rate-limit turn error to the rate_limited outcome (shared classifyTurnFailure)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);
    // A spend-cap / rate-limit error from the turn must fold into the amber
    // `rate_limited` outcome via the shared `classifyTurnFailure`, not `failed`.
    runAssistantTurnMock.mockRejectedValue(
      new Error("Daily spend cap reached for free models")
    );

    const result = await runSyntheticHostSession(baseAdapter() as never);

    expect(result.outcome).toBe("rate_limited");
  });
});

/** Fake outbox that logs into the shared `callOrder`. */
function buildFakeOutbox(overrides?: { flush?: () => Promise<unknown> }) {
  return {
    take: vi.fn((_browser: unknown, promptIndex: number) => {
      callOrder.push(`outbox.take:${promptIndex}`);
    }),
    stageVideo: vi.fn(async () => {
      callOrder.push("outbox.stageVideo");
    }),
    flush: vi.fn(async () => {
      callOrder.push("outbox.flush");
      return (
        (await overrides?.flush?.()) ?? {
          written: 1,
          pending: 0,
          videoAttached: true,
        }
      );
    }),
    pendingBatchCount: 0,
  };
}

describe("runSyntheticHostSession — durable browser-artifact capture", () => {
  it("captures before teardown and persists after it", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    fake.collectVideo.mockImplementation(async () => {
      callOrder.push("collectVideo");
      return Buffer.from("webm");
    });
    createBrowserSessionContextMock.mockReturnValue(fake);
    const outbox = buildFakeOutbox();

    const result = await runSyntheticHostSession({
      ...baseAdapter(),
      browserArtifacts: outbox,
    } as never);
    expect(result.outcome).toBe("succeeded");

    // The ordering that matters: the video is collected and the last drain
    // taken while Chromium is alive, teardown happens next, and only THEN does
    // the network work run — so a stalled upload can't pin the browser or the
    // MCP manager open behind it.
    // The last take comes BEFORE collectVideo: `collectVideo` closes the
    // Playwright context to flush the `.webm`, so a hook documented as running
    // "while the browser is alive" has to be ahead of it.
    const terminal = callOrder.slice(callOrder.lastIndexOf("outbox.take:0"));
    expect(terminal).toEqual([
      "outbox.take:0",
      "collectVideo",
      "dispose",
      "outbox.stageVideo",
      "outbox.flush",
    ]);
  });

  it("persists the session row AND its artifacts when the first turn fails", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);
    const outbox = buildFakeOutbox();
    // A first-turn failure is the case you most want to watch back — and it
    // used to return with no `chatSessions` row at all.
    runAssistantTurnMock.mockReset().mockRejectedValue(new Error("engine down"));
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const result = await runSyntheticHostSession({
      ...baseAdapter(),
      browserArtifacts: outbox,
    } as never);

    expect(result.outcome).toBe("failed");
    // A row exists for the artifacts to attach to...
    expect(persistChatSessionToConvexMock).toHaveBeenCalledTimes(1);
    expect(persistChatSessionToConvexMock.mock.calls[0]![0]).toMatchObject({
      chatSessionId: "synth_run-1_p1_0",
      sourceType: "swarm",
    });
    // ...and the turn's artifacts were taken and flushed against it.
    expect(outbox.take).toHaveBeenCalled();
    expect(outbox.flush).toHaveBeenCalled();
    expect(callOrder).toContain("dispose");
  });

  it("takes + flushes per turn so a mid-session crash keeps earlier turns", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);
    const outbox = buildFakeOutbox();

    await runSyntheticHostSession({
      ...baseAdapter(),
      browserArtifacts: outbox,
    } as never);

    // Turn 0's take/flush happen inline, not only at the terminal.
    expect(outbox.take.mock.calls.map((c) => c[1])).toEqual([0, 0]);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
  });

  it("a terminal-path failure never changes the session's outcome", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    fake.collectVideo.mockRejectedValue(new Error("chromium gone"));
    createBrowserSessionContextMock.mockReturnValue(fake);
    const outbox = buildFakeOutbox();
    outbox.flush.mockRejectedValue(new Error("convex down"));

    const result = await runSyntheticHostSession({
      ...baseAdapter(),
      browserArtifacts: outbox,
    } as never);

    // Observability must never be able to fail a session that succeeded — and
    // teardown still has to happen.
    expect(result.outcome).toBe("succeeded");
    expect(callOrder).toContain("dispose");
  });

  it("persists the row when browser construction never happened", async () => {
    // A `prepareChatV2` / context-construction failure lands here: no browser at
    // all, so nothing to capture — but the attempt still needs a `chatSessions`
    // row or it can't be opened alongside the run.
    createBrowserSessionContextMock.mockImplementation(() => {
      throw new Error("chromium unavailable");
    });
    const outbox = buildFakeOutbox();
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const result = await runSyntheticHostSession({
      ...baseAdapter(),
      browserArtifacts: outbox,
    } as never);

    expect(result.outcome).toBe("failed");
    expect(persistChatSessionToConvexMock).toHaveBeenCalledTimes(1);
    // Nothing to collect, so the outbox is untouched.
    expect(outbox.take).not.toHaveBeenCalled();
  });

  it("without an outbox, the terminal path is teardown only (pre-feature)", async () => {
    const fake = buildFakeBrowserContext({ computerUse: true });
    createBrowserSessionContextMock.mockReturnValue(fake);

    await runSyntheticHostSession(baseAdapter() as never);

    expect(fake.collectVideo).not.toHaveBeenCalled();
    expect(callOrder.at(-1)).toBe("dispose");
  });
});
