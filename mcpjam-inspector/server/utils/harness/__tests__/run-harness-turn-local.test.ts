import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "Done",
  stateExists: true,
  streamError: null as Error | null,
  create: vi.fn(),
  continuations: [] as unknown[],
  teardown: vi.fn(async () => {}),
  discardState: vi.fn(async () => {}),
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    detach: vi.fn(async () => ({ data: { bridge: { sandboxId: "local-session" } } })),
    suspendTurn: vi.fn(async () => ({ type: "continue-turn" })),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = async (options: any) => {
      harnessState.create(options);
      harnessState.session.sessionId = options.sessionId;
      return harnessState.session;
    };
    continueStream = async () => this.stream();
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        if (harnessState.streamError) throw harnessState.streamError;
        for (const part of harnessState.streamParts) {
          yield part;
        }
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
  },
  // WS3: no trailing tool-approval-response parts in these prompts.
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => harnessState.continuations),
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
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
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

import {
  runHarnessTurn,
} from "../run-harness-turn";
import { claimHarnessSessionState, commitHarnessSessionState, releaseHarnessSessionState } from "../harness-session-state.js";
import { prepareLocalHarnessTurn } from "../local/local-turn.js";
import { reserveHarnessBox, renewHarnessBoxReservation, startHarnessModelBroker } from "../harness-model-broker.js";

vi.mock("../local/local-turn.js", () => ({
  prepareLocalHarnessTurn: vi.fn(async () => ({
    ok: true,
    prepared: {
      plan: { runtime: { runtimeId: "runtime-1" } },
      sandbox: {}, auth: {}, sandboxWorkDir: "project",
      permissionMode: "allow-edits",
      sessionStateExists: harnessState.stateExists,
      teardown: harnessState.teardown,
      discardState: harnessState.discardState,
    },
  })),
}));

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
    sourceType: "direct",
    chatSessionId: "chat-1",
    harnessExecutionTarget: {
      kind: "local-native", machineId: "machine-1", runtimeId: "runtime-1",
      workspaceGrantId: "workspace-1", permissionProfile: "workspace-edits",
      policyVersion: "v1", grantToken: "grant", actingUserId: "user-1",
    },
    onConversationComplete: vi.fn(async () => ({ outcome: "saved" })),
    harness: "claude-code",
    ...overrides,
  };
}


describe("runHarnessTurn local continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
    harnessState.continuations = [];
    harnessState.stateExists = true;
    harnessState.streamError = null;
    harnessState.discardState.mockImplementation(async () => {
      harnessState.stateExists = false;
    });
    harnessState.session.destroy.mockImplementation(async () => {
      harnessState.stateExists = false;
    });
    harnessState.session.detach.mockImplementation(async () => ({
      data: { bridge: { sandboxId: harnessState.session.sessionId } },
    }));
    vi.mocked(claimHarnessSessionState).mockResolvedValue({
      ok: true, leaseId: "lease-1", stateVersion: 1, state: null,
      fingerprintChanged: false,
    } as any);
  });
  afterEach(() => vi.unstubAllEnvs());

  function resume(awaitingApproval = false) {
    vi.mocked(claimHarnessSessionState).mockResolvedValue({
      ok: true, leaseId: "lease-1", stateVersion: 1, fingerprintChanged: false,
      state: {
        harnessSessionId: "local-session", computerId: "machine-1:runtime-1",
        resumeState: { data: { bridge: { sandboxId: "local-session" } } },
        awaitingApproval,
      },
    } as any);
  }

  it("binds preparation and first SDK session to one id without any cloud reservation", async () => {
    await runHarnessTurn(baseOptions() as any, "none");
    expect(prepareLocalHarnessTurn).toHaveBeenCalledOnce();
    const id = vi.mocked(prepareLocalHarnessTurn).mock.calls[0]![0].sessionId;
    expect(id).toMatch(/^local-/);
    expect(harnessState.create).toHaveBeenCalledWith({ sessionId: id });
    expect(reserveHarnessBox).not.toHaveBeenCalled();
    expect(renewHarnessBoxReservation).not.toHaveBeenCalled();
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
    expect(harnessState.teardown).toHaveBeenCalledOnce();
    expect(harnessState.discardState).not.toHaveBeenCalled();
  });

  it("resumes the state persisted by the first turn", async () => {
    let saved: any;
    const options = baseOptions({
      onConversationComplete: async (_messages: unknown, _trace: unknown, commit: unknown) => {
        saved = commit;
        return { outcome: "saved" };
      },
    });
    await runHarnessTurn(options as any, "none");
    expect(saved.computerId).toBe("machine-1:runtime-1");
    const id = saved.harnessSessionId;
    vi.mocked(claimHarnessSessionState).mockResolvedValue({
      ok: true, leaseId: "lease-2", stateVersion: 2,
      fingerprintChanged: false, state: saved,
    } as any);
    await runHarnessTurn(options as any, "none");
    expect(prepareLocalHarnessTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: id }),
    );
    expect(harnessState.create).toHaveBeenLastCalledWith({
      sessionId: id, resumeFrom: saved.resumeState,
    });
    expect(harnessState.discardState).not.toHaveBeenCalled();
  });

  it("continues a paused approval with the same identity", async () => {
    resume(true);
    harnessState.continuations = [{ approvalId: "approval-1", approved: true }];
    await runHarnessTurn(baseOptions() as any, "none");
    expect(prepareLocalHarnessTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "local-session" }));
    expect(harnessState.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "local-session", continueFrom: expect.any(Object) }));
  });

  it("retains state after committing a paused approval", async () => {
    harnessState.streamParts = [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }];
    await runHarnessTurn(baseOptions() as any, "none");
    expect(commitHarnessSessionState).toHaveBeenCalledWith(expect.objectContaining({ awaitingApproval: true }));
    expect(harnessState.teardown).toHaveBeenCalledOnce();
    expect(harnessState.discardState).not.toHaveBeenCalled();
  });

  it("discards state when the completed turn could not be persisted", async () => {
    await runHarnessTurn(baseOptions({ onConversationComplete: async () => ({ outcome: "failed" }) }) as any, "none");
    expect(harnessState.discardState).toHaveBeenCalledOnce();
    expect(harnessState.discardState.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(releaseHarnessSessionState).mock.invocationCallOrder[0]!,
    );
  });


  it("starts a new identity when the runtime changes", async () => {
    resume();
    const options = baseOptions();
    options.harnessExecutionTarget.runtimeId = "runtime-2";
    await runHarnessTurn(options as any, "none");
    const id = vi.mocked(prepareLocalHarnessTurn).mock.calls[0]![0].sessionId;
    expect(id).not.toBe("local-session");
    expect(harnessState.create).toHaveBeenCalledWith({ sessionId: id });
  });

  it("refuses approval continuation after the runtime changes", async () => {
    resume(true);
    harnessState.continuations = [{ approvalId: "approval-1", approved: true }];
    const options = baseOptions();
    options.harnessExecutionTarget.runtimeId = "runtime-2";
    await runHarnessTurn(options as any, "none");
    expect(prepareLocalHarnessTurn).not.toHaveBeenCalled();
    expect(harnessState.create).not.toHaveBeenCalled();
  });

  it("discards state after a one-shot run without a continuity lane", async () => {
    await runHarnessTurn(baseOptions({ sourceType: "eval", chatSessionId: undefined }) as any, "none");
    expect(harnessState.session.destroy).toHaveBeenCalledOnce();
    expect(harnessState.teardown).toHaveBeenCalledOnce();
    expect(harnessState.discardState).toHaveBeenCalledOnce();
  });

  it("discards an approval suspension whose commit failed", async () => {
    vi.mocked(commitHarnessSessionState).mockResolvedValueOnce(false);
    harnessState.streamParts = [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }];
    await runHarnessTurn(baseOptions() as any, "none");
    expect(harnessState.discardState).toHaveBeenCalledOnce();
  });

  it.each(["stop", "error", "persist-failure"])(
    "recovers on turn 3 after turn 2 ends with %s and removes its state",
    async (failure) => {
      let saved: any;
      let persistFails = false;
      const options = baseOptions({
        onConversationComplete: async (_messages: unknown, _trace: unknown, commit: unknown) => {
          if (persistFails) return { outcome: "failed" };
          saved = commit;
          return { outcome: "saved" };
        },
      });
      await runHarnessTurn(options as any, "none");
      const firstState = saved;
      vi.mocked(claimHarnessSessionState).mockResolvedValue({
        ok: true, leaseId: "lease-2", stateVersion: 2,
        fingerprintChanged: false, state: firstState,
      } as any);
      if (failure === "persist-failure") {
        persistFails = true;
      } else {
        harnessState.streamError = failure === "stop"
          ? new DOMException("Stopped", "AbortError")
          : new Error("Turn failed");
      }
      await runHarnessTurn(options as any, "none");
      expect(harnessState.stateExists).toBe(false);
      expect(saved).toBe(firstState);
      harnessState.streamError = null;
      persistFails = false;

      const result = await runHarnessTurn(options as any, "ui");
      const stream = await result.response!.text();
      expect(stream).toContain('"type":"data-harness-reset"');
      expect(stream).toContain('"reason":"resume-failed"');
      expect(harnessState.create).toHaveBeenLastCalledWith({
        sessionId: firstState.harnessSessionId,
      });
      expect(saved.harnessSessionId).toBe(firstState.harnessSessionId);
      expect(saved).not.toBe(firstState);
      expect(stream).toContain("Done");
    },
  );

  it("rejects an approval whose local state was removed", async () => {
    resume(true);
    harnessState.stateExists = false;
    harnessState.continuations = [{ approvalId: "approval-1", approved: true }];
    await runHarnessTurn(baseOptions() as any, "none");
    expect(harnessState.create).not.toHaveBeenCalled();
    expect(harnessState.teardown).toHaveBeenCalledOnce();
  });

  it("does not create an unrelated fresh session on a local resume failure", async () => {
    resume();
    harnessState.create.mockImplementationOnce(() => { throw new Error("bad resume"); });
    await runHarnessTurn(baseOptions() as any, "none");
    expect(harnessState.create).toHaveBeenCalledOnce();
    expect(harnessState.teardown).toHaveBeenCalledOnce();
    expect(harnessState.discardState).toHaveBeenCalledOnce();
  });
});
