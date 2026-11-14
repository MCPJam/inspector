/**
 * `harness_turn_completed` from a real `runHarnessTurn`: exactly one event per
 * turn, sent when the turn's response closes, whether it completed, failed or
 * was stopped, on the browser stream and on the public API's inline run.
 *
 * The module mocks are the ones `run-harness-turn-hosted-resume.test.ts`
 * drives a turn with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  streamError: null as Error | null,
  /** Thrown once every part has gone out. */
  errorAfterParts: null as Error | null,
  afterFirstPart: null as (() => void) | null,
  claim: {
    stateVersion: 1,
    fingerprintChanged: false,
    state: null as unknown,
  } as Record<string, unknown>,
  /** Fields over the stock adapter, for a turn that qualifies as warm. */
  adapter: {} as Record<string, unknown>,
  approvalContinuations: [] as unknown[],
  createSession: vi.fn(async (_opts?: unknown) => ({
    sessionId: "harness-session-0",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    detach: vi.fn(async () => ({})),
    suspendTurn: vi.fn(async () => ({ type: "continue-turn" })),
  })),
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = harnessState.createSession;
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        if (harnessState.streamError) throw harnessState.streamError;
        for (const part of harnessState.streamParts) {
          yield part;
          harnessState.afterFirstPart?.();
        }
        if (harnessState.errorAfterParts) throw harnessState.errorAfterParts;
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
    continueStream = this.stream;
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(
    () => harnessState.approvalContinuations,
  ),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn(() => ({
    id: "claude-code",
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    mcpDelivery: "mcpjam",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
    ...harnessState.adapter,
  })),
}));

// The warm wrapper is replaced: the test hears what the turn hands it, and
// answers the attach the way the wrapper does, while the session starts.
vi.mock("../warm-bridge-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../warm-bridge-runtime.js")>()),
  withWarmBridgeRuntime: vi.fn(() => ({ harnessId: "claude-code" })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));

vi.mock("../runtime-skills.js", () => ({
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../harness-session-state.js")>();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      ...harnessState.claim,
    })),
    commitHarnessSessionState: vi.fn(async () => true),
    heartbeatHarnessSessionState: vi.fn(async () => "ok"),
    releaseHarnessSessionState: vi.fn(async () => {}),
  };
});

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

vi.mock("../mcp-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-config.js")>();
  return {
    ...actual,
    buildHarnessMcpJson: vi.fn(() => ({ mcpServers: {} })),
    harnessServerInputFromConfig: vi.fn(),
    harnessServerKeyToName: vi.fn((key: string) => key),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import { admitWarmChatManager } from "../warm-approval-binding.js";
import {
  withWarmBridgeRuntime,
  type WarmAttachOutcome,
} from "../warm-bridge-runtime.js";
import { logger } from "../../logger.js";
import { TurnTiming } from "../../turn-timing.js";
import type { HarnessTurnEventSink } from "../harness-turn-event.js";
import type { HarnessTurnEventProperties } from "@/shared/harness-turn-event";

const BRIDGE = {
  port: 39271,
  token: "t",
  lastSeenEventId: 4,
  sandboxId: "sandbox-1",
};

const resumable = (computerId = "computer-1") => ({
  harnessSessionId: "harness-session-0",
  computerId,
  resumeState: {
    type: "resume-session",
    harnessId: "claude-code",
    specificationVersion: "harness-v1",
    data: { claudeSessionId: "claude-1", bridge: BRIDGE },
  },
});

function turn(
  surface: "web" | "api" = "web",
  extra: Record<string, unknown> = {},
) {
  const sink = { surface, capture: vi.fn() };
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hello?" }],
    } as unknown as ModelMessage,
  ];
  const options = {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    chatSessionId: "chat-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "direct",
    harness: "claude-code",
    turnTiming: new TurnTiming({
      harnessTurnEvent: sink as HarnessTurnEventSink,
    }),
    ...extra,
  };
  return { sink, options };
}

/** Runs the browser stream to its end, as the client reading it does. */
async function runToClose(options: unknown) {
  const result = await runHarnessTurn(options as never, "ui");
  await result.response!.text();
}

function onlyEvent(sink: { capture: ReturnType<typeof vi.fn> }) {
  expect(sink.capture).toHaveBeenCalledTimes(1);
  return sink.capture.mock.calls[0]![0] as HarnessTurnEventProperties;
}

describe("runHarnessTurn: harness_turn_completed", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    harnessState.streamParts = [
      { type: "text-delta", delta: "Hi." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Hi.";
    harnessState.streamError = null;
    harnessState.errorAfterParts = null;
    harnessState.afterFirstPart = null;
    harnessState.claim = {
      stateVersion: 1,
      fingerprintChanged: false,
      state: resumable(),
    };
    harnessState.approvalContinuations = [];
    harnessState.adapter = {};
  });

  afterEach(() => vi.unstubAllEnvs());

  it("sends one event when a browser turn's response closes", async () => {
    const { sink, options } = turn("web");
    await runToClose(options);
    const event = onlyEvent(sink);
    expect(event).toMatchObject({
      surface: "web",
      harness_id: "claude-code",
      outcome: "completed",
      bootstrap: "unknown",
      kind: "follow_up",
      start: "disk_resume",
      fallback_reason: "none",
    });
    for (const field of [
      "first_text_ms",
      "claim_ms",
      "box_wake_ms",
      "broker_start_ms",
      "session_connect_ms",
      "dispatch_setup_ms",
      "model_stream_ms",
    ]) {
      expect(event[field as keyof HarnessTurnEventProperties]).toEqual(
        expect.any(Number),
      );
    }
  });

  it("counts the route's acquisition of the box toward the box wake, and no other stage", async () => {
    const { sink, options } = turn("web");
    let now = 0;
    const timing = new TurnTiming({
      harnessTurnEvent: sink as HarnessTurnEventSink,
      now: () => now,
    });
    // The route created or woke the conversation's box before the turn began.
    await timing.timeBoxAcquisition(async () => {
      now += 1_700;
    });
    await runToClose({ ...options, turnTiming: timing });
    const event = onlyEvent(sink);
    expect(event.box_wake_ms).toBeGreaterThanOrEqual(1_700);
    for (const field of [
      "claim_ms",
      "broker_start_ms",
      "session_connect_ms",
      "dispatch_setup_ms",
      "model_stream_ms",
    ] as const) {
      expect(event[field]).toEqual(expect.any(Number));
      expect(event[field]).toBeLessThan(1_700);
    }
  });

  it("reports the public API's inline turn, first text included", async () => {
    const info = vi.spyOn(logger, "info");
    const { sink, options } = turn("api");
    await runHarnessTurn(options as never, "none");
    expect(onlyEvent(sink)).toMatchObject({
      surface: "api",
      outcome: "completed",
      first_text_ms: expect.any(Number),
    });
    // The turn's `[harness][timing]` line carries it too.
    const timingLines = info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[harness][timing] "));
    expect(timingLines).toEqual([expect.stringMatching(/ firstTextMs=\d+/)]);
    info.mockRestore();
  });

  it("reports a first message on a lane with no committed state as a new session", async () => {
    harnessState.claim = {
      stateVersion: 0,
      fingerprintChanged: false,
      state: null,
    };
    const { sink, options } = turn();
    await runToClose(options);
    expect(onlyEvent(sink)).toMatchObject({
      kind: "first",
      start: "new",
      fallback_reason: "none",
    });
  });

  it.each([
    [
      "a changed runtime",
      { stateVersion: 2, fingerprintChanged: true, state: resumable() },
      "configuration_changed",
    ],
    [
      "a replaced box",
      {
        stateVersion: 2,
        fingerprintChanged: false,
        state: resumable("computer-2"),
      },
      "sandbox_replaced",
    ],
  ])("says why %s started fresh", async (_label, claim, fallback) => {
    harnessState.claim = claim;
    const { sink, options } = turn();
    await runToClose(options);
    expect(onlyEvent(sink)).toMatchObject({
      kind: "follow_up",
      start: "new",
      fallback_reason: fallback,
    });
  });

  it("reports an approval decision as continuing the paused turn", async () => {
    harnessState.claim = {
      stateVersion: 3,
      fingerprintChanged: false,
      state: {
        harnessSessionId: "harness-session-0",
        computerId: "computer-1",
        awaitingApproval: true,
        resumeState: {
          type: "continue-turn",
          harnessId: "claude-code",
          specificationVersion: "harness-v1",
          data: { claudeSessionId: "claude-1", bridge: BRIDGE },
          pendingToolApprovals: [{ approvalId: "approval-1" }],
        },
      },
    };
    harnessState.approvalContinuations = [
      { approvalId: "approval-1", approved: true },
    ];
    const { sink, options } = turn();
    await runToClose(options);
    expect(onlyEvent(sink)).toMatchObject({
      start: "approval_continuation",
      outcome: "completed",
    });
  });

  it("sends one event for a failed turn, with nothing from its error", async () => {
    harnessState.streamError = new Error(
      "upstream https://49983-sbx.e2b.app/v1 failed reading /home/user/work/notes.txt " +
        "with Bearer sk-ant-api03-secret in sandbox sbx_9f2c41d7",
    );
    const { sink, options } = turn();
    await runToClose(options);
    const event = onlyEvent(sink);
    expect(event).toMatchObject({ outcome: "failed", start: "disk_resume" });
    expect(event).not.toHaveProperty("model_stream_ms");
    const serialized = JSON.stringify(event);
    for (const leak of [
      /https?:/,
      /\//,
      /Bearer|sk-ant/,
      /sbx_|sandbox-1|e2b/,
      /notes\.txt/,
      /hello\?/,
    ]) {
      expect(serialized).not.toMatch(leak);
    }
  });

  it("reports a turn that asked for an approval and then failed as failed", async () => {
    harnessState.streamParts = [
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCall: { toolCallId: "call-1" },
      },
    ];
    harnessState.errorAfterParts = new Error("The bridge closed the turn.");
    const onEngineError = vi.fn();
    const { sink, options } = turn("web", { onEngineError });
    await runToClose(options);
    // The turn failed: its error reached the caller.
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onlyEvent(sink)).toMatchObject({ outcome: "failed" });
  });

  it("sends one event for a stopped turn", async () => {
    const stop = new AbortController();
    harnessState.afterFirstPart = () => stop.abort();
    const { sink, options } = turn("web", { abortSignal: stop.signal });
    await runToClose(options);
    expect(onlyEvent(sink)).toMatchObject({
      outcome: "aborted",
      kind: "follow_up",
    });
  });

  describe("on a box that keeps a warm agent", () => {
    /** The conversation's box, with the idle window a warm agent needs. */
    const BOX = {
      sandboxRowId: "computer-1",
      sandboxId: "sandbox-1",
      idleMs: 300_000,
    };

    /** A Playground turn the warm gate admits, whose attach answers `outcome`. */
    async function warmTurn(outcome: WarmAttachOutcome) {
      harnessState.adapter = {
        pinnedRuntimeVersion: "runtime-1",
        forwardingRuntime: { runtimeVersion: "runtime-1" },
      };
      harnessState.claim = {
        stateVersion: 2,
        fingerprintChanged: false,
        supportsApprovalFence: true,
        state: resumable(),
      };
      const { sink, options } = turn("web", {
        harnessSandboxBinding: BOX,
        harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
      });
      admitWarmChatManager(options.mcpClientManager as never, "org-1", false);
      const startSession = harnessState.createSession.getMockImplementation()!;
      harnessState.createSession.mockImplementationOnce(async (opts) => {
        const [, , , onAttach] = vi.mocked(withWarmBridgeRuntime).mock.lastCall!;
        onAttach?.(outcome);
        return startSession(opts);
      });
      await runToClose(options);
      return onlyEvent(sink);
    }

    it("hands the wrapper the box's idle window and the turn's attach report", async () => {
      vi.mocked(withWarmBridgeRuntime).mockClear();
      await warmTurn("attached");
      expect(withWarmBridgeRuntime).toHaveBeenCalledOnce();
      const [, , windowMs, onAttach] = vi.mocked(withWarmBridgeRuntime).mock.calls[0]!;
      expect(windowMs).toBe(BOX.idleMs);
      expect(onAttach).toEqual(expect.any(Function));
    });

    it("reports a re-attached bridge as a warm start", async () => {
      expect(await warmTurn("attached")).toMatchObject({
        surface: "web",
        kind: "follow_up",
        start: "warm",
        fallback_reason: "none",
      });
    });

    it("reports a bridge the probe refused as a resume from saved files that says why", async () => {
      expect(await warmTurn("probe_refused")).toMatchObject({
        start: "disk_resume",
        fallback_reason: "probe_refused",
      });
    });
  });

  it("runs a turn whose caller installed no recorder (an eval) without one", async () => {
    const { sink, options } = turn("web", { turnTiming: undefined });
    await runHarnessTurn(options as never, "none");
    expect(sink.capture).not.toHaveBeenCalled();
  });
});
