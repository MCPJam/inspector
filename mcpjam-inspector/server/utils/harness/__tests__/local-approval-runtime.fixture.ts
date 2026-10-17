import { vi } from "vitest";
import type { MCPJamHandlerOptions } from "../../mcpjam-stream-handler.js";
import { localApprovalFixture as state } from "./local-approval-agent.fixture.js";
import {
  claimParkedLocalSession,
  noteParkedLocalSessionEnded,
  parkLocalSession,
  releaseParkedLocalSession,
} from "../local/approval-park.js";
import {
  endLocalHarnessSession,
  registerLocalHarnessSession,
} from "../local/session-registry.js";
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
export { state as localApprovalFixture, options as localApprovalOptions };
