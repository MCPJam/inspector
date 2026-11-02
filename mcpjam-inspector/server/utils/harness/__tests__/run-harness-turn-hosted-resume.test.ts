/** Hosted continuations pass live candidates to the bounded runtime guard.
 * Approval decisions retain their original paused-turn continuation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

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

vi.mock("@ai-sdk/harness/agent", () => ({
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
  collectHarnessAgentToolApprovalContinuations: vi.fn(
    () => harnessState.approvalContinuations,
  ),
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
    supportsWarmBridge: true,
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    mcpDelivery: "mcpjam",
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

  it("passes the prior bridge to the bounded hosted runtime for validation", async () => {
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
        data: { claudeSessionId: "claude-1", bridge: BRIDGE },
      },
    });
  });

  it("A pauses, B runs, A decides: the decision reattaches to A's bridge", async () => {
    // B's turn on the same computer preserves paused approvals; A's,
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
});
