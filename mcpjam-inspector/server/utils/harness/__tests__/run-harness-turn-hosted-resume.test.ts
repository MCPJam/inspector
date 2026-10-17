/**
 * A resumed hosted turn respawns its bridge and resumes the conversation from
 * disk; it never hands the adapter the last turn's bridge to reattach to. A
 * reattach whose bridge is gone — reaped as idle by another chat's spawn, or
 * stopped with its computer — is retried by the adapter for its whole 120s
 * startup timeout before it falls back: the two-minute stall this pins shut.
 *
 * The one exception is an approval decision: the paused turn lives in its
 * bridge (which the reaper never stops), so the continuation reattaches.
 *
 * The module mocks are the ones `run-harness-turn-provenance.test.ts` drives
 * a turn with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { convertToModelMessages } from "ai";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  claimedState: null as unknown,
  approvalContinuations: [] as unknown[],
  createSession: vi.fn(async (_opts?: unknown) => ({
    sessionId: "harness-session-0",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    detach: vi.fn(async () => ({})),
  })),
}));

vi.mock("@ai-sdk/harness/agent", async (original) => {
  const actual = await original<typeof import("@ai-sdk/harness/agent")>();
  return {
    ...actual,
    HarnessAgent: class {
      createSession = harnessState.createSession;
      stream = vi.fn(async () => ({
        fullStream: (async function* () {
          for (const part of harnessState.streamParts) {
            yield part;
          }
        })(),
        text: Promise.resolve(harnessState.finalText),
      }));
      continueStream = this.stream;
    },
    // WS3: the user's approval decision, when a test sends one.
    collectHarnessAgentToolApprovalContinuations: vi.fn((args) =>
      harnessState.approvalContinuations.length > 0
        ? harnessState.approvalContinuations
        : actual.collectHarnessAgentToolApprovalContinuations(args),
    ),
  };
});

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
    supportsNativeToolApproval: true,
    supportsMcpToolApproval: true,
    supportsHostExecutedToolApproval: true,
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
  const actual =
    await importOriginal<typeof import("../harness-session-state.js")>();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 1,
      state: harnessState.claimedState,
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

const BRIDGE = {
  port: 39271,
  token: "t",
  lastSeenEventId: 4,
  sandboxId: "sandbox-1",
};

function options() {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hello?" }],
    } as unknown as ModelMessage,
  ];
  return {
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
  };
}

describe("runHarnessTurn hosted resume", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    harnessState.streamParts = [
      { type: "text-delta", delta: "Hi." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Hi.";
    harnessState.createSession.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    harnessState.claimedState = null;
    harnessState.approvalContinuations = [];
  });

  it("resumes the session from disk instead of reattaching to the last bridge", async () => {
    harnessState.claimedState = {
      harnessSessionId: "harness-session-0",
      computerId: "computer-1",
      resumeState: {
        type: "resume-session",
        harnessId: "claude-code",
        specificationVersion: "harness-v1",
        data: { claudeSessionId: "claude-1", bridge: BRIDGE },
      },
    };

    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();

    expect(harnessState.createSession).toHaveBeenCalledWith({
      sessionId: "harness-session-0",
      resumeFrom: {
        type: "resume-session",
        harnessId: "claude-code",
        specificationVersion: "harness-v1",
        data: { claudeSessionId: "claude-1" },
      },
    });
  });

  it("A pauses, B runs, A decides: the decision reattaches to A's bridge", async () => {
    // B's turn on the same computer reaped only bridges between turns; A's,
    // paused on the approval, is still there and still holds the turn.
    const paused = {
      type: "continue-turn",
      harnessId: "claude-code",
      specificationVersion: "harness-v1",
      data: { claudeSessionId: "claude-1", bridge: BRIDGE },
      pendingToolApprovals: [{ approvalId: "approval-1" }],
    };
    harnessState.claimedState = {
      harnessSessionId: "harness-session-0",
      computerId: "computer-1",
      awaitingApproval: true,
      resumeState: paused,
    };
    harnessState.approvalContinuations = [
      { approvalId: "approval-1", approved: true },
    ];

    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();

    expect(harnessState.createSession).toHaveBeenCalledWith({
      sessionId: "harness-session-0",
      continueFrom: paused,
    });
  });
  it("delivers a fresh hosted denial through the real SDK collector", async () => {
    const paused = {
      type: "continue-turn",
      harnessId: "claude-code",
      specificationVersion: "harness-v1",
      data: { claudeSessionId: "claude-1", bridge: BRIDGE },
      pendingToolApprovals: [{ approvalId: "denial-1" }],
    };
    harnessState.claimedState = {
      harnessSessionId: "harness-session-0",
      computerId: "computer-1",
      awaitingApproval: true,
      resumeState: paused,
    };
    const input = options();
    input.requireToolApproval = true;
    input.messages = await convertToModelMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "denied-call",
            input: { command: "touch denied" },
            state: "approval-responded",
            providerExecuted: true,
            approval: { id: "denial-1", approved: false },
          },
        ],
      },
    ]);
    const result = await runHarnessTurn(
      input as Parameters<typeof runHarnessTurn>[0],
      "ui",
    );
    expect(await result.response!.text()).toContain(
      '"type":"tool-output-denied","toolCallId":"denied-call"',
    );
    expect(harnessState.createSession).toHaveBeenCalledWith({
      sessionId: "harness-session-0",
      continueFrom: paused,
    });
  });
});
