/**
 * HARNESS CONFORMANCE FOR THE TURN OUTCOME RECORD.
 *
 * The sibling of `utils/__tests__/turn-outcome-conformance.test.ts`, which
 * covers the emulated engine. Two runtimes produce the same record their own
 * way, so each needs its own table: the harness marks its endings from places
 * the emulated engine does not have at all — a pre-stream abort that happens
 * before any driver exists, a lease the supervisor lost underneath the turn,
 * an approval pause whose commit then failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        for (const part of harnessState.streamParts) {
          yield part;
        }
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
  },
  // WS3: no trailing tool-approval-response parts in these prompts.
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  // Broker-only credential delivery (COMP-23): the turn builds dummy auth
  // pointed at the broker proxy; there is no per-adapter resolveAuth anymore.
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
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../runtime-skills.js", () => ({
  frontmatterSafeSkills: vi.fn((skills) => skills),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../harness-session-state.js")
  >();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 1,
      state: null,
      fingerprintChanged: false,
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
import { turnOutcomeRecordZ } from "@/shared/turn-outcome";
import { terminationOf } from "@/shared/turn-outcome";
import type { TurnOutcomeRecord } from "@/shared/turn-outcome";
import { createCancellationReason } from "../../stream-turn-driver";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "create a file called empty.txt" }],
    } as unknown as ModelMessage,
  ];

  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "eval",
    harness: "claude-code",
    ...overrides,
  };
}


async function runOutcome(
  overrides: Record<string, unknown> = {},
): Promise<{
  outcome: TurnOutcomeRecord | undefined;
  viaCallback: TurnOutcomeRecord | undefined;
}> {
  let viaCallback: TurnOutcomeRecord | undefined;
  const result = await runHarnessTurn(
    baseOptions({
      onTurnOutcome: (outcome: TurnOutcomeRecord) => {
        viaCallback = outcome;
      },
      ...overrides,
    }) as any,
    "none",
  );
  return { outcome: result.outcome, viaCallback };
}

describe("harness engine outcome conformance", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    harnessState.streamParts = [];
    harnessState.finalText = "";
    harnessState.session.stop.mockClear();
    harnessState.session.destroy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("COMPLETED: names the runtime, its host, and the provider's finish reason", async () => {
    harnessState.streamParts = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ];
    harnessState.finalText = "done";

    const { outcome, viaCallback } = await runOutcome();
    expect(outcome?.lifecycle).toBe("completed");
    expect(outcome?.runtime).toEqual({
      engine: "harness",
      harness: "claude-code",
      modelAccess: "hosted",
    });
    expect(outcome?.finishReason).toBe("stop");
    expect(terminationOf(outcome)).toBeUndefined();
    expect(viaCallback).toEqual(outcome);
  });

  it("CANCELLED before the stream opens: marked even though NO DRIVER EXISTS yet", async () => {
    // The driver is only built once `agent.stream()` resolves — after
    // credentials, box wake, broker start and session connect. This is the
    // exact ending the function-scoped builder exists for; it used to leave
    // nothing behind at all.
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await runOutcome({
      abortSignal: controller.signal,
      cancellationSource: "client_disconnect",
    });
    expect(outcome?.lifecycle).toBe("cancelled");
    expect(terminationOf(outcome)?.cancellationSource).toBe("client_disconnect");
  });

  it("CANCELLED by a lost lease names the lease, not the user", async () => {
    // The harness collapsed four causes into one boolean. An operator reading
    // "cancelled" could not tell a user pressing Stop from a lease the runtime
    // lost underneath them, which are different bugs.
    const controller = new AbortController();
    controller.abort(
      createCancellationReason("lease_lost", "harness lease lost"),
    );
    const { outcome } = await runOutcome({
      abortSignal: controller.signal,
      cancellationSource: "client_disconnect",
    });
    expect(terminationOf(outcome)?.cancellationSource).toBe("lease_lost");
  });

  it("TIMED OUT: a fired deadline names its clock instead of reading as cancelled", async () => {
    const controller = new AbortController();
    controller.abort(
      Object.assign(new Error("turn budget expired"), {
        name: "AbortError",
        clock: "turn",
        budgetMs: 360_000,
      }),
    );
    const { outcome } = await runOutcome({ abortSignal: controller.signal });
    expect(outcome?.lifecycle).toBe("timed_out");
    expect(terminationOf(outcome)?.timeout?.clock).toBe("turn");
    expect(terminationOf(outcome)?.cancellationSource).toBeUndefined();
  });

  it("CANCELLED mid-stream leaves a DISPATCHED tool call as outcome_unknown", async () => {
    // On the harness the call is already inside the sandbox by the time the
    // part arrives — the runtime executes it itself — so a cancel from here
    // leaves a call that may have taken effect. Saying "never started" would
    // be the reassuring lie this distinction exists to prevent.
    const controller = new AbortController();
    harnessState.streamParts = [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "charge_card",
        input: {},
      },
      // The engine checks the signal at the top of each iteration, so aborting
      // between parts exits through the in-stream gate.
      { type: "__abort__" },
      { type: "finish", finishReason: "stop" },
    ];
    const parts = harnessState.streamParts;
    harnessState.streamParts = parts.map((part) =>
      part.type === "__abort__"
        ? {
            get type() {
              controller.abort();
              return "text-delta";
            },
            delta: "",
          }
        : part,
    ) as typeof parts;

    const { outcome } = await runOutcome({ abortSignal: controller.signal });
    expect(outcome?.lifecycle).toBe("cancelled");
    expect(terminationOf(outcome)?.unresolvedToolCalls).toEqual([
      {
        toolCallId: "call-1",
        toolName: "charge_card",
        state: "outcome_unknown",
      },
    ]);
  });

  it("FAILED: a turn that never reached the model is attributed to setup", async () => {
    // A missing `projectId` throws INSIDE the turn's own try, so the function
    // returns normally and the record is the account of what happened. The
    // flag it reads is set at the model handover, which this never reached —
    // so the failure is ours, not the provider's. Getting that backwards is
    // how a wiring bug gets filed against the model vendor.
    const { outcome, viaCallback } = await runOutcome({ projectId: undefined });
    expect(outcome?.lifecycle).toBe("failed");
    expect(terminationOf(outcome)?.errorSource).toBe("setup");
    expect(viaCallback).toEqual(outcome);
  });

  it("a wiring error BEFORE the turn's own try still rejects, and records nothing", async () => {
    // `harness` is read to pick the adapter, before anything the builder
    // watches. This asserts the REJECTION rather than swallowing it: the
    // contract is that a throw out of `runHarnessTurn` is the caller's to
    // classify, and a test that caught it either way would pass just as
    // happily if the turn silently started recording `completed` instead.
    await expect(runOutcome({ harness: undefined })).rejects.toThrow();
  });

  it("every record this engine produces satisfies the contract", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
    harnessState.finalText = "done";
    const { outcome } = await runOutcome();
    expect(turnOutcomeRecordZ.safeParse(outcome).success).toBe(true);
  });
});
