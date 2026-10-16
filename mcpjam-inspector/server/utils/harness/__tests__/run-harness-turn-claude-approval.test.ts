import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToModelMessages } from "ai";
import type { MCPJamHandlerOptions } from "../../mcpjam-stream-handler.js";
import {
  claimParkedLocalSession,
  describeParkedLocalSession,
  noteParkedLocalSessionEnded,
  parkLocalSession,
  releaseParkedLocalSession,
  resetApprovalParkForTests,
} from "../local/approval-park.js";
import {
  endLocalHarnessSession,
  listLocalHarnessSessions,
  registerLocalHarnessSession,
  resetLocalHarnessRegistryForTests,
} from "../local/session-registry.js";

const state = vi.hoisted(() => ({
  saved: null as Record<string, unknown> | null,
  sessionId: "",
  alive: false,
  resumed: 0,
  executions: 0,
  currentApproval: 1,
  maxApprovals: 1,
  harnessId: "claude-code" as "claude-code" | "codex",
  teardown: vi.fn(),
  hold: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@ai-sdk/harness/agent", async (original) => ({
  ...(await original<typeof import("@ai-sdk/harness/agent")>()),
  HarnessAgent: class {
    async createSession(options: { sessionId: string }) {
      state.sessionId = options.sessionId;
      state.create(options);
      return {
        sessionId: options.sessionId,
        suspendTurn: async () => ({
          type: "continue-turn",
          harnessId: state.harnessId,
          specificationVersion: "harness-v1",
          data: {
            bridge: {
              port: 4100,
              token: "claude-generation",
              lastSeenEventId: 3,
            },
          },
        }),
        detach: async () => ({ type: "resume-session", data: {} }),
        destroy: async () => {},
        stop: async () => ({}),
      };
    }
    private result(completedCall?: number) {
      const pending = state.currentApproval;
      return {
        fullStream: (async function* () {
          if (completedCall !== undefined)
            yield {
              type: "tool-result",
              toolCallId: `call-${completedCall}`,
              toolName: "bash",
              result: "Done",
            };
          if (pending <= state.maxApprovals) {
            yield {
              type: "tool-call",
              toolCallId: `call-${pending}`,
              toolName: "bash",
              input: JSON.stringify({ command: `touch example-${pending}` }),
              providerExecuted: true,
            };
            yield {
              type: "tool-approval-request",
              approvalId: `a${pending}`,
              toolCallId: `call-${pending}`,
            };
          } else yield { type: "finish", finishReason: "stop" };
        })(),
        text: Promise.resolve(pending > state.maxApprovals ? "Done" : ""),
      };
    }
    async stream() {
      return this.result();
    }
    async continueStream(options: {
      toolApprovalContinuations: { approved: boolean }[];
    }) {
      state.resumed++;
      const approved = options.toolApprovalContinuations[0]?.approved;
      if (approved) state.executions++;
      const previous = state.currentApproval++;
      return this.result(approved ? previous : undefined);
    }
  },
}));
vi.mock("../local/pack-bootstrap.js", () => ({
  withLocalRuntimeBootstrap: async (adapter: unknown) => adapter,
}));
vi.mock("../runtime-skills.js", async (original) => ({
  ...(await original<typeof import("../runtime-skills.js")>()),
  frontmatterSafeSkills: (skills: unknown) => skills,
  skillsFingerprint: () => "empty",
  fetchRuntimeSkills: async () => ({ ok: true, skills: [] }),
  fetchRuntimeSkillFiles: async () => ({ ok: true, files: [] }),
}));
vi.mock("../preseed-adapter-skills.js", () => ({
  handOffLegacySkillDirs: async () => {},
  preseedAdapterSkills: async () => {},
}));
vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: async () => {},
  appendManagedSkills: async () => {},
}));
vi.mock("../mcp-config.js", async (original) => ({
  ...(await original<typeof import("../mcp-config.js")>()),
  buildHarnessMcpJson: () => ({ mcpServers: {} }),
}));
vi.mock("../harness-session-state.js", async (original) => ({
  ...(await original<typeof import("../harness-session-state.js")>()),
  claimHarnessSessionState: async () => ({
    ok: true,
    leaseId: "lease-1",
    stateVersion: 1,
    state: state.saved,
    fingerprintChanged: false,
  }),
  commitHarnessSessionState: async (input: Record<string, unknown>) => {
    state.saved = input;
    return true;
  },
  heartbeatHarnessSessionState: async () => "ok",
  releaseHarnessSessionState: async () => {},
}));
vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: async () => ({ ok: true }),
  renewHarnessBoxReservation: async () => ({ ok: true }),
  releaseHarnessBoxReservation: async () => ({ ok: true }),
  revokeHarnessModelBroker: async () => {},
}));
vi.mock("../local/evidence.js", () => ({
  localHarnessEvidence: async () => ({
    decision: { captureEnabled: false, gradingSource: "narration" },
  }),
}));
vi.mock("../local/local-turn.js", () => ({
  prepareLocalHarnessTurn: async (args: {
    sessionId: string;
    approvalContinuation?: { generation: string; approvalIds: string[] };
  }) => {
    if (args.approvalContinuation) {
      const claim = claimParkedLocalSession({
        sessionId: args.sessionId,
        ...args.approvalContinuation,
        userId: "user-1",
        projectId: "project-1",
      });
      if (!claim.ok)
        return { ok: false, status: claim.reason, message: claim.message };
    } else {
      state.alive = true;
      registerLocalHarnessSession({
        sessionId: args.sessionId,
        runtimeId: "runtime-1",
        workspaceGrantId: "workspace-1",
        gateway: null,
        brokerRunId: null,
        revokeLease: null,
        releaseRuntime: null,
        startedAt: Date.now(),
        onEnded: () => noteParkedLocalSessionEnded(args.sessionId),
        stop: async () => {
          state.alive = false;
          state.teardown();
          return { stopped: true };
        },
      });
    }
    return {
      ok: true,
      prepared: {
        plan: { runtime: { runtimeId: "runtime-1" } },
        sandbox: {},
        auth: {},
        sandboxWorkDir: "project",
        skillsBaseDir: "/local/home/.claude/skills",
        permissionMode: "allow-reads",
        timings: { localRuntimeVerifyMs: 0, localGatewayReadyMs: 0 },
        sessionStateExists: true,
        teardown: () => endLocalHarnessSession(args.sessionId),
        discardState: async () => {},
        park: (input: { generation: string; pendingApprovalIds: string[] }) =>
          parkLocalSession({
            sessionId: args.sessionId,
            userId: "user-1",
            projectId: "project-1",
            ...input,
            resources: {},
            isAlive: () => state.alive,
            holdModelTraffic: state.hold,
            end: async () => {
              await endLocalHarnessSession(args.sessionId);
            },
          }),
        unpark: () => releaseParkedLocalSession(args.sessionId),
      },
    };
  },
}));

import { runHarnessTurn } from "../run-harness-turn.js";
import { getHarnessAdapter } from "../registry.js";

function options(
  overrides: Partial<MCPJamHandlerOptions> = {},
): MCPJamHandlerOptions {
  return {
    messages: [{ role: "user", content: "write a file" }],
    modelId: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    systemPrompt: "Use tools.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() } as never,
    selectedServers: [],
    requireToolApproval: true,
    sourceType: "direct",
    chatSessionId: "chat-1",
    harness: "claude-code",
    harnessExecutionTarget: {
      kind: "local-native",
      machineId: "machine-1",
      runtimeId: "runtime-1",
      workspaceGrantId: "workspace-1",
      permissionProfile: "workspace-edits",
      policyVersion: "v1",
      grantToken: "grant",
      actingUserId: "user-1",
    },
    onConversationComplete: async () => ({ outcome: "saved" }),
    ...overrides,
  } as MCPJamHandlerOptions;
}
async function request(input = options()) {
  const result = await runHarnessTurn(input, "ui");
  if (!result.response) throw new Error("expected an HTTP stream response");
  return result.response.text();
}

async function answer(approved: boolean) {
  const messages = await convertToModelMessages([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "touch example" },
          state: "approval-responded",
          providerExecuted: true,
          approval: { id: "a1", approved },
        },
      ],
    },
  ]);
  return request(options({ messages }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.saved = null;
  state.alive = false;
  state.resumed = 0;
  state.executions = 0;
  state.currentApproval = 1;
  state.maxApprovals = 1;
  state.harnessId = "claude-code";
  resetApprovalParkForTests();
  resetLocalHarnessRegistryForTests();
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
});
afterEach(() => {
  resetApprovalParkForTests();
  resetLocalHarnessRegistryForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Claude approval through the turn runner's pause and teardown", () => {
  it.each([true, false])(
    "reattaches across requests for approved=%s",
    async (approved) => {
      expect(getHarnessAdapter("claude-code").liveApprovalRuntime).toBe(true);
      const responseBody = await request();
      expect(responseBody).toContain("tool-approval-request");
      expect(state.saved).toMatchObject({
        resumeState: { data: { bridge: { token: "claude-generation" } } },
      });
      expect(state.hold).toHaveBeenCalledOnce();
      expect(state.teardown).not.toHaveBeenCalled();
      const continuation = await answer(approved);
      expect(continuation).not.toContain('"type":"error"');
      expect(state.resumed).toBe(1);
      expect(state.executions).toBe(Number(approved));
      expect(state.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ continueFrom: expect.any(Object) }),
      );
      expect(state.teardown).toHaveBeenCalledOnce();
      expect(listLocalHarnessSessions()).toHaveLength(0);
      await answer(approved);
      expect(state.resumed).toBe(1);
    },
  );
  it("survives reload reads then resumes the same pending approval", async () => {
    await request();
    for (let i = 0; i < 2; i++)
      expect(
        describeParkedLocalSession(state.sessionId)?.pendingApprovalIds,
      ).toEqual(["a1"]);
    await answer(true);
    expect(state.executions).toBe(1);
  });
  it("Stop while waiting empties the process registry and refuses a late answer", async () => {
    await request();
    await endLocalHarnessSession(state.sessionId);
    expect(listLocalHarnessSessions()).toHaveLength(0);
    await answer(true);
    expect(state.executions).toBe(0);
    expect(state.resumed).toBe(0);
  });
  it("park expiry stops the process and refuses a late answer", async () => {
    vi.useFakeTimers();
    await request();
    expect(describeParkedLocalSession(state.sessionId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await answer(true);
    await vi.waitFor(() => expect(listLocalHarnessSessions()).toHaveLength(0));
    await answer(true);
    expect(state.resumed).toBe(0);
  });
});

export { state as localApprovalFixture, options as localApprovalOptions };
