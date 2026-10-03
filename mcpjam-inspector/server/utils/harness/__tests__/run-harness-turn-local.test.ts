vi.mock("../local/pack-bootstrap.js", () => ({ withLocalPackBootstrap: async (adapter: unknown) => adapter }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "Done",
  stateExists: true,
  invokeSandboxCallback: false,
  supportsSkills: false,
  agentOptions: {} as any,
  createRuntime: vi.fn(() => ({ harnessId: "claude-code" })),
  streamError: null as Error | null,
  create: vi.fn(),
  continuations: [] as unknown[],
  teardown: vi.fn(async () => {}),
  discardState: vi.fn(async () => {}),
  liveApprovalRuntime: false,
  adapterOverrides: {} as Record<string, unknown>,
  park: vi.fn((_args: unknown) => true),
  unpark: vi.fn(() => {}),
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
    constructor(options: any) { harnessState.agentOptions = options; }
    createSession = async (options: any) => {
      harnessState.create(options);
      harnessState.session.sessionId = options.sessionId;
      if (harnessState.invokeSandboxCallback) {
        await harnessState.agentOptions.onSandboxSession({
          session: { writeTextFile: vi.fn() }, sessionWorkDir: "/private/local/work/project",
        });
      }
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
    supportsSkills: harnessState.supportsSkills,
    skillsBaseDir: "/home/user/.claude/skills",
    skillsWriteOptions: { trailingNewline: true },
    prepareSkills: (skills: any[]) => ({ delivered: skills, payload: skills }),
    mcpDelivery: "native",
    mcpNativeDelivery: "session-config",
    supportsModel: vi.fn(() => true),
    liveApprovalRuntime: harnessState.liveApprovalRuntime,
    createHarness: harnessState.createRuntime,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
    ...harnessState.adapterOverrides,
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
  fetchRuntimeSkillFiles: vi.fn(async () => ({ ok: true, files: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
  appendManagedSkills: vi.fn(async () => {}),
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
import { getHarnessAdapter } from "../registry.js";
import { prepareLocalHarnessTurn } from "../local/local-turn.js";
import { reserveHarnessBox, renewHarnessBoxReservation, startHarnessModelBroker } from "../harness-model-broker.js";

vi.mock("../local/local-turn.js", () => ({
  prepareLocalHarnessTurn: vi.fn(async () => ({
    ok: true,
    prepared: {
      plan: { runtime: { runtimeId: "runtime-1" } },
      sandbox: {}, auth: {}, sandboxWorkDir: "project",
      skillsBaseDir: "/private/local/home/.claude/skills",
      permissionMode: "allow-edits",
      sessionStateExists: harnessState.stateExists,
      teardown: harnessState.teardown,
      discardState: harnessState.discardState,
      park: harnessState.park,
      unpark: harnessState.unpark,
    },
  })),
}));

vi.mock("../local/evidence.js", () => ({
  localHarnessEvidence: vi.fn(async () => ({
    decision: { captureEnabled: false, gradingSource: "narration" },
  })),
}));
import { localHarnessEvidence } from "../local/evidence.js";

vi.mock("../preseed-adapter-skills.js", () => ({
  handOffLegacySkillDirs: vi.fn(async () => {}),
  preseedAdapterSkills: vi.fn(async () => {}),
}));
vi.mock("../materialize-skill-files.js", () => ({ materializeSkillFiles: vi.fn(async () => {}) }));
vi.mock("../materialize-skill-frontmatter.js", () => ({ materializeSkillFrontmatter: vi.fn(async () => {}) }));
vi.mock("../pinned-harness-skills.js", async (original) => ({
  ...await original<typeof import("../pinned-harness-skills.js")>(),
  materializePinnedSkillFiles: vi.fn(async () => {}),
}));
vi.mock("../adopt-sandbox-skills.js", async (original) => ({
  ...await original<typeof import("../adopt-sandbox-skills.js")>(),
  adoptSandboxSkills: vi.fn(async () => ({ adopted: [{ skillId: "new", name: "new" }] })),
}));
import { handOffLegacySkillDirs, preseedAdapterSkills } from "../preseed-adapter-skills.js";
import { materializeSkillFiles } from "../materialize-skill-files.js";
import { materializeSkillFrontmatter } from "../materialize-skill-frontmatter.js";
import { materializePinnedSkillFiles } from "../pinned-harness-skills.js";
import { adoptSandboxSkills } from "../adopt-sandbox-skills.js";
import { reconcileSkillDirs, appendManagedSkills } from "../reconcile-skill-dirs.js";

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
    harnessState.invokeSandboxCallback = false;
    harnessState.supportsSkills = false;
    harnessState.streamError = null;
    harnessState.liveApprovalRuntime = false;
    harnessState.adapterOverrides = {};
    harnessState.park.mockReset().mockReturnValue(true);
    harnessState.unpark.mockReset();
    harnessState.session.suspendTurn.mockImplementation(async () => ({ type: "continue-turn" }));
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

  it("wires the granted workspace and materialized secrets into local preparation", async () => {
    const delivered = vi.fn();
    await runHarnessTurn(baseOptions({
      runtimeSecrets: [{ name: "SERVICE_KEY", value: "test-value", secretId: "secret-1" }],
      onSecretEnvDelivered: delivered,
    }) as any, "none");
    expect(harnessState.agentOptions.sandboxConfig).toEqual({ workDir: "project" });
    expect(prepareLocalHarnessTurn).toHaveBeenCalledWith(expect.objectContaining({
      scopedEnv: { SERVICE_KEY: "test-value" }, onSecretEnvDelivered: delivered,
    }));
    expect(harnessState.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mcpJson: { mcpServers: {} },
    }));
  });

  it.each(["environment", "pinned"])("uses the local skill root for every %s skill pass", async (mode) => {
    harnessState.invokeSandboxCallback = true;
    harnessState.supportsSkills = true;
    const skill = { skillId: "skill-1", name: "test-skill", description: "test", content: "body", contentHash: "hash", aggregateHash: "hash" };
    await runHarnessTurn(baseOptions(mode === "pinned"
      ? { pinnedHarnessSkills: [skill] }
      : { runtimeSkillsOverride: [skill] }) as any, "none");
    const common = [reconcileSkillDirs, handOffLegacySkillDirs, preseedAdapterSkills, materializeSkillFrontmatter];
    const passes = mode === "pinned"
      ? [...common, materializePinnedSkillFiles]
      : [...common, materializeSkillFiles, adoptSandboxSkills, appendManagedSkills];
    for (const pass of passes) {
      expect(pass).toHaveBeenCalledWith(expect.objectContaining({
        skillsBase: "/private/local/home/.claude/skills",
      }));
    }
  });

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

  it("refuses unrestricted direct turns before preparing a local runtime", async () => {
    const options = baseOptions();
    options.harnessExecutionTarget.permissionProfile = "unrestricted";
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
    "preserves the saved conversation on turn 3 after turn 2 ends with %s",
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
      expect(harnessState.stateExists).toBe(true);
      expect(harnessState.discardState).not.toHaveBeenCalled();
      expect(releaseHarnessSessionState).toHaveBeenCalled();
      expect(saved).toBe(firstState);
      harnessState.streamError = null;
      persistFails = false;

      const result = await runHarnessTurn(options as any, "ui");
      const stream = await result.response!.text();
      expect(stream).not.toContain('"type":"data-harness-reset"');
      expect(harnessState.create).toHaveBeenLastCalledWith({
        sessionId: firstState.harnessSessionId, resumeFrom: firstState.resumeState,
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
    expect(harnessState.discardState).not.toHaveBeenCalled();
    expect(releaseHarnessSessionState).toHaveBeenCalled();
  });

  describe("a runtime whose pending approval lives in its process (local Codex)", () => {
    beforeEach(() => {
      harnessState.liveApprovalRuntime = true;
      harnessState.session.suspendTurn.mockImplementation(async () => ({
        type: "continue-turn",
        data: { bridge: { port: 4100, token: "gen-1", lastSeenEventId: 7 } },
      }));
    });

    function pausedLane() {
      vi.mocked(claimHarnessSessionState).mockResolvedValue({
        ok: true, leaseId: "lease-1", stateVersion: 1, fingerprintChanged: false,
        state: {
          harnessSessionId: "local-session", computerId: "machine-1:runtime-1",
          resumeState: {
            type: "continue-turn",
            data: { bridge: { port: 4100, token: "gen-1", lastSeenEventId: 7 } },
          },
          awaitingApproval: true,
        },
      } as any);
    }

    it("looks the adapter up for the LOCAL venue", async () => {
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(getHarnessAdapter).toHaveBeenCalledWith("codex", { localExecution: true });
    });

    it("parks the live runtime at an approval pause instead of tearing it down", async () => {
      harnessState.streamParts = [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }];
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(commitHarnessSessionState).toHaveBeenCalledWith(expect.objectContaining({ awaitingApproval: true }));
      expect(harnessState.park).toHaveBeenCalledWith({ generation: "gen-1", pendingApprovalIds: ["approval-1"] });
      // The parked record owns cleanup now: no teardown, no discard, and the
      // process is not handed back to ordinary teardown either.
      expect(harnessState.teardown).not.toHaveBeenCalled();
      expect(harnessState.discardState).not.toHaveBeenCalled();
      expect(harnessState.unpark).not.toHaveBeenCalled();
    });

    it("tears down as usual when the session was ended before it could park", async () => {
      harnessState.park.mockReturnValue(false);
      harnessState.streamParts = [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }];
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(harnessState.teardown).toHaveBeenCalledOnce();
    });

    it("never parks a pause whose continuation could not be committed", async () => {
      vi.mocked(commitHarnessSessionState).mockResolvedValueOnce(false);
      harnessState.streamParts = [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }];
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(harnessState.park).not.toHaveBeenCalled();
      expect(harnessState.teardown).toHaveBeenCalledOnce();
    });

    it("delivers the decision to the parked process generation and hands it back after", async () => {
      pausedLane();
      harnessState.continuations = [{ approvalResponse: { approvalId: "approval-1", approved: true } }];
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(prepareLocalHarnessTurn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "local-session",
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }));
      expect(harnessState.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "local-session", continueFrom: expect.any(Object),
      }));
      // Finished without pausing again: back to ordinary teardown, in order.
      expect(harnessState.unpark).toHaveBeenCalledOnce();
      expect(harnessState.unpark.mock.invocationCallOrder[0]).toBeLessThan(
        harnessState.teardown.mock.invocationCallOrder[0]!,
      );
    });

    it("refuses a decision when the parked runtime refuses it, running nothing", async () => {
      pausedLane();
      harnessState.continuations = [{ approvalResponse: { approvalId: "approval-1", approved: true } }];
      vi.mocked(prepareLocalHarnessTurn).mockResolvedValueOnce({
        ok: false, status: "approval-duplicate-approval",
        message: "This approval was already answered; the action will not run twice.",
      } as any);
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(harnessState.create).not.toHaveBeenCalled();
    });

    it("refuses a decision with no recorded process generation instead of replaying it", async () => {
      vi.mocked(claimHarnessSessionState).mockResolvedValue({
        ok: true, leaseId: "lease-1", stateVersion: 1, fingerprintChanged: false,
        state: {
          harnessSessionId: "local-session", computerId: "machine-1:runtime-1",
          resumeState: { type: "continue-turn", data: {} },
          awaitingApproval: true,
        },
      } as any);
      harnessState.continuations = [{ approvalResponse: { approvalId: "approval-1", approved: true } }];
      await runHarnessTurn(baseOptions({ harness: "codex" }) as any, "none");
      expect(prepareLocalHarnessTurn).not.toHaveBeenCalled();
      expect(harnessState.create).not.toHaveBeenCalled();
    });
  });
  describe("an unattended local Codex eval (D2/D6)", () => {
    const defaultPrepare = vi.mocked(prepareLocalHarnessTurn).getMockImplementation();
    afterEach(() => {
      if (defaultPrepare) vi.mocked(prepareLocalHarnessTurn).mockImplementation(defaultPrepare);
    });
    const codexEval = (overrides: Record<string, unknown> = {}) =>
      baseOptions({
        harness: "codex",
        modelId: "openai/gpt-5.5",
        sourceType: "eval",
        evalIterationId: "iteration-1",
        chatSessionId: undefined,
        harnessExecutionTarget: {
          kind: "local-native", machineId: "machine-1", runtimeId: "runtime-1",
          workspaceGrantId: "scratch-1", permissionProfile: "unrestricted",
          policyVersion: "v1", grantToken: "grant", actingUserId: "user-1",
        },
        ...overrides,
      });

    beforeEach(() => {
      harnessState.liveApprovalRuntime = true;
      // Preparation resolves the same manifest mapping: unrestricted → allow-all.
      vi.mocked(prepareLocalHarnessTurn).mockImplementation(async (args: any) => ({
        ok: true,
        prepared: {
          plan: { runtime: { runtimeId: "runtime-1" } },
          sandbox: {}, auth: {}, sandboxWorkDir: "project",
          skillsBaseDir: "/private/local/home/.agents/skills",
          permissionMode:
            args?.target?.permissionProfile === "unrestricted" ? "allow-all" : "allow-edits",
          sessionStateExists: harnessState.stateExists,
          teardown: harnessState.teardown,
          discardState: harnessState.discardState,
          park: harnessState.park,
          unpark: harnessState.unpark,
        },
      }) as any);
      harnessState.adapterOverrides = {
        id: "codex",
        displayName: "Codex",
        mcpDelivery: "host-executed",
        mcpNativeDelivery: undefined,
        acceptsSandboxPolicy: true,
      };
    });

    it("builds the runtime allow-all inside the explicit workspace-write sandbox", async () => {
      await runHarnessTurn(codexEval() as any, "none");
      expect(harnessState.createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: false,
          },
        }),
      );
      expect(harnessState.agentOptions.permissionMode).toBe("allow-all");
    });

    it("never hands the sandbox policy to an attended Playground turn", async () => {
      await runHarnessTurn(
        baseOptions({ harness: "codex", modelId: "openai/gpt-5.5" }) as any,
        "none",
      );
      expect(harnessState.createRuntime).toHaveBeenCalled();
      expect(
        (harnessState.createRuntime.mock.calls[0] as unknown[])[0],
      ).not.toHaveProperty("sandboxPolicy");
    });

    it("refuses an unrestricted target outside an eval or swarm, before preparing anything", async () => {
      await runHarnessTurn(
        codexEval({ sourceType: "direct", evalIterationId: undefined, chatSessionId: "chat-1" }) as any,
        "none",
      );
      expect(prepareLocalHarnessTurn).not.toHaveBeenCalled();
      expect(harnessState.createRuntime).not.toHaveBeenCalled();
    });

    it("refuses to run unattended on a transport that cannot apply the sandbox", async () => {
      harnessState.adapterOverrides = {
        ...harnessState.adapterOverrides,
        acceptsSandboxPolicy: false,
      };
      await runHarnessTurn(codexEval() as any, "none");
      expect(harnessState.createRuntime).not.toHaveBeenCalled();
    });

    it("skips member evidence for the host-executed engine and reports narration grading", async () => {
      const onHarnessEvidenceDecision = vi.fn();
      await runHarnessTurn(
        codexEval({ onHarnessEvidenceDecision }) as any,
        "none",
      );
      expect(localHarnessEvidence).not.toHaveBeenCalled();
      expect(onHarnessEvidenceDecision).toHaveBeenCalledWith(
        expect.objectContaining({ captureEnabled: false, gradingSource: "narration" }),
      );
    });
  });
});
