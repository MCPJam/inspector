/**
 * A harness turn on the ORGANIZATION'S own provider key: the lease it runs on
 * names the key's credential revision, and a session resumes only state that
 * was produced on the SAME key. A renamed connection keeps its key and
 * resumes; a replaced key starts a fresh runtime session. The committed
 * state is stamped with the revision so the next turn can tell.
 *
 * The module mocks are the ones `run-harness-turn-hosted-resume.test.ts`
 * drives a turn with, plus an org lease from the broker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  claimedState: null as unknown,
  approvalContinuations: [] as unknown[],
  leaseRevision: "rev_a",
  createHarness: vi.fn((_args?: unknown) => ({ harnessId: "claude-code" })),
  toNativeModel: vi.fn((modelId: string, _upstream?: unknown) => modelId),
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
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: harnessState.createHarness,
    toNativeModel: harnessState.toNativeModel,
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
  reserveHarnessBox: vi.fn(async () => ({
    ok: true,
    credentialRevision: harnessState.leaseRevision,
  })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
    orgUpstream: {
      credentialSource: "org",
      profile: "anthropic-native",
      nativeModelId: "claude-sonnet-4-5",
      credentialRevision: harnessState.leaseRevision,
    },
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
import { commitHarnessSessionState } from "../harness-session-state.js";
import {
  reserveHarnessBox,
  startHarnessModelBroker,
} from "../harness-model-broker.js";
import { stampOrgCredentialRevision } from "../org-credential-continuity";

const ADAPTER_STATE = {
  type: "resume-session",
  harnessId: "claude-code",
  specificationVersion: "harness-v1",
  data: { claudeSessionId: "claude-1" },
};

const ORG_SELECTION = {
  source: "org",
  modelId: "anthropic/claude-sonnet-4.5",
  connectionRef: { kind: "orgProvider", id: "conn_1" },
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
    // The org row's own (native) id; the selection names the canonical one.
    modelId: "claude-sonnet-4-5",
    provider: "anthropic",
    modelSelection: ORG_SELECTION,
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

describe("runHarnessTurn on the organization's own key", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    harnessState.streamParts = [
      { type: "text-delta", delta: "Hi." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Hi.";
    harnessState.createSession.mockClear();
    harnessState.createHarness.mockClear();
    harnessState.toNativeModel.mockClear();
    vi.mocked(commitHarnessSessionState).mockClear();
    vi.mocked(reserveHarnessBox).mockClear();
    vi.mocked(startHarnessModelBroker).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    harnessState.claimedState = null;
    harnessState.leaseRevision = "rev_a";
  });

  function claimStampedWith(revision: string) {
    harnessState.claimedState = {
      harnessSessionId: "harness-session-0",
      computerId: "computer-1",
      resumeState: stampOrgCredentialRevision(ADAPTER_STATE, revision),
    };
  }

  it("reserves and starts with the selection under its CANONICAL id", async () => {
    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();
    expect(vi.mocked(reserveHarnessBox).mock.lastCall?.[0]).toMatchObject({
      modelId: "anthropic/claude-sonnet-4.5",
      modelSelection: ORG_SELECTION,
    });
    expect(vi.mocked(startHarnessModelBroker).mock.lastCall?.[0]).toMatchObject(
      {
        modelId: "anthropic/claude-sonnet-4.5",
        modelSelection: ORG_SELECTION,
        // The revision the reserve prepared: a key replaced since is refused.
        expectedCredentialRevision: "rev_a",
      },
    );
  });

  it("runs the runtime natively on the leased model", async () => {
    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();
    const upstream = {
      profile: "anthropic-native",
      nativeModelId: "claude-sonnet-4-5",
    };
    expect(harnessState.toNativeModel).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4.5",
      upstream,
    );
    expect(harnessState.createHarness.mock.lastCall?.[0]).toMatchObject({
      upstream,
    });
  });

  it("a renamed connection (same key) resumes the session", async () => {
    claimStampedWith("rev_a");
    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();
    // The adapter sees exactly the state it wrote, never the stamp.
    expect(harnessState.createSession).toHaveBeenCalledWith({
      sessionId: "harness-session-0",
      resumeFrom: ADAPTER_STATE,
    });
  });

  it("a replaced key starts a fresh runtime session", async () => {
    claimStampedWith("rev_a");
    harnessState.leaseRevision = "rev_b";
    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();
    const opts = harnessState.createSession.mock.lastCall?.[0] as
      Record<string, unknown> | undefined;
    expect(opts?.resumeFrom).toBeUndefined();
    expect(opts?.continueFrom).toBeUndefined();
  });

  it("commits the session state stamped with the lease's credential revision", async () => {
    const onConversationComplete = vi.fn(async () => ({
      outcome: "saved" as const,
    }));
    harnessState.leaseRevision = "rev_c";
    const result = await runHarnessTurn(
      { ...options(), onConversationComplete } as any,
      "ui",
    );
    await result.response!.text();
    await vi.waitFor(() => expect(onConversationComplete).toHaveBeenCalled());
    const commit = (onConversationComplete.mock.lastCall as unknown[])?.[2] as
      { resumeState?: unknown } | undefined;
    // `detach()` returned `{}`: the adapter's state, wrapped with the revision.
    expect(commit?.resumeState).toEqual(
      stampOrgCredentialRevision({}, "rev_c"),
    );
  });

  it("a state never produced on an org key is not resumed by an org turn", async () => {
    harnessState.claimedState = {
      harnessSessionId: "harness-session-0",
      computerId: "computer-1",
      resumeState: ADAPTER_STATE,
    };
    const result = await runHarnessTurn(options() as any, "ui");
    await result.response!.text();
    const opts = harnessState.createSession.mock.lastCall?.[0] as
      Record<string, unknown> | undefined;
    expect(opts?.resumeFrom).toBeUndefined();
  });
});
