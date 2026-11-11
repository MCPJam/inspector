/**
 * A harness turn that offers MCP-server skills: what the turn hands
 * `HarnessAgent` (the skill tools, the gate's permission mode, the prompt
 * section, a box without the server's skill) and that the runtime it hands
 * over answers its requests through MCPJam's gate.
 *
 * The adapter is a stand-in with Codex's real skills descriptor; the gate's
 * answers are covered by `server-skill-command-gate.test.ts`, and the tools by
 * `harness-server-skills.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
  HarnessV1,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";

const agentConstruction = vi.hoisted(() => ({
  last: undefined as Record<string, unknown> | undefined,
}));

/** The runtime the adapter builds: its requests are sent by hand below. */
const runtime = vi.hoisted(() => ({
  emit: undefined as undefined | ((part: Record<string, unknown>) => void),
  submitToolApproval: vi.fn(async () => {}),
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(options: Record<string, unknown>) {
      agentConstruction.last = options;
    }
    createSession = vi.fn(async () => ({
      sessionId: "session-1",
      stop: vi.fn(async () => ({})),
      destroy: vi.fn(async () => {}),
    }));
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", async () => {
  const { HARNESS_SKILLS } = await import("../skills-descriptor.js");
  const fakeRuntime = () => ({
    harnessId: "codex",
    doStart: async () => ({
      doPromptTurn: async (options: {
        emit: (part: Record<string, unknown>) => void;
      }) => {
        runtime.emit = options.emit;
        return {
          submitToolResult: async () => {},
          submitToolApproval: runtime.submitToolApproval,
          done: Promise.resolve(),
        };
      },
    }),
  });
  return {
    buildBrokerDummyAuth: vi.fn(() => ({
      anthropic: {
        apiKey: "",
        authToken: "dummy",
        baseUrl: "https://broker.example",
      },
    })),
    getHarnessAdapter: vi.fn(() => ({
      id: "codex",
      pinnedRuntimeVersion: "0.163.0",
      displayName: "Codex",
      defaultPermissionMode: "allow-all",
      approvalPermissionMode: "allow-reads",
      supportsNativeToolApproval: true,
      supportsHostExecutedToolApproval: true,
      supportsMcpToolApproval: false,
      supportsSkills: true,
      skills: HARNESS_SKILLS.codex,
      mcpDelivery: "mcpjam",
      supportsModel: vi.fn(() => true),
      toNativeModel: vi.fn(() => "gpt-5"),
      createHarness: vi.fn(fakeRuntime),
      parseToolName: vi.fn((toolName: string) => ({ toolName })),
    })),
  };
});

vi.mock("../host-executed-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../host-executed-mcp-tools.js")>()),
  projectSelectedMcpServersAsHostTools: vi.fn(async () => ({
    tools: {},
    keyToServerId: {},
  })),
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
vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
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
}));
vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
    forwarding: {},
    expiresAt: Date.now() + 60_000,
  })),
}));

import { renderUserContextText } from "@/shared/user-context-message";
import { buildServerSkillToolOutput } from "@/shared/server-skill-banner";
import { runHarnessTurn } from "../run-harness-turn";
import { COMMAND_REFUSED_IN_USE } from "../server-skill-command-gate";
import { preparedRunSkills } from "../../../test/support/skill-delivery";

const ASK = {
  role: "user",
  content: [{ type: "text", text: "search the docs" }],
};

/** The user picked the docs server's skill with `/` in this message. */
const PICKED = {
  role: "user",
  content: [
    {
      type: "text",
      text: renderUserContextText({
        kind: "skill",
        subject: "docs/search",
        body: buildServerSkillToolOutput({
          ref: "docs/search",
          serverLabel: "Docs",
          skillUri: "skill://docs/search",
          content: "# Search\n\nRun `scripts/search.sh` first.",
        }),
      }),
    },
  ],
};

async function evalTurn(overrides: Record<string, unknown> = {}) {
  const run = await preparedRunSkills();
  await runHarnessTurn(
    {
      messages: [ASK] as unknown as ModelMessage[],
      modelId: "openai/gpt-5",
      provider: "openai",
      systemPrompt: "You are Codex.",
      authHeader: "Bearer test",
      projectId: "project-1",
      mcpClientManager: { getServerConfig: vi.fn(() => ({ url: "x" })) },
      selectedServers: ["srv_docs"],
      harnessMcpProxy: { plane: "local-mcp" as const },
      requireToolApproval: false,
      sourceType: "eval",
      approvalMode: "auto-deny",
      harness: "codex",
      pinnedHarnessSkills: run.pinnedHarnessSkills,
      ...overrides,
    } as never,
    "none",
  );
  return agentConstruction.last!;
}

/** Start the runtime the turn handed over and send it one command request. */
async function sendCommand(agent: Record<string, unknown>) {
  const harness = agent.harness as HarnessV1;
  const session = await harness.doStart({} as never);
  const forwarded: HarnessV1StreamPart[] = [];
  const control = (await session.doPromptTurn({
    emit: (part: HarnessV1StreamPart) => forwarded.push(part),
  } as never)) as HarnessV1PromptControl;
  runtime.emit!({
    type: "tool-call",
    toolCallId: "cmd",
    toolName: "bash",
    nativeName: "exec_command",
    input: "{}",
    providerExecuted: true,
  });
  runtime.emit!({
    type: "tool-approval-request",
    approvalId: "approval-cmd",
    toolCallId: "cmd",
  });
  await control.done;
  return forwarded;
}

beforeEach(() => {
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
  agentConstruction.last = undefined;
  runtime.submitToolApproval.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a harness turn with a server skill", () => {
  it("hands the runtime MCPJam's skill tools, which never ask", async () => {
    const agent = await evalTurn();
    const tools = agent.tools as Record<string, Record<string, unknown>>;
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["loadSkill", "listSkillFiles", "readSkillFile"]),
    );
    for (const name of ["loadSkill", "listSkillFiles", "readSkillFile"]) {
      expect(tools[name]).not.toHaveProperty("needsApproval");
    }
    expect(agent.toolApproval).toBeUndefined();
  });

  it("names the server's skill in the instructions and keeps it off the box", async () => {
    const agent = await evalTurn();
    expect(agent.instructions).toContain("You are Codex.");
    expect(agent.instructions).toContain("**docs/search**");
    expect(
      (agent.skills as Array<{ name: string }>).map((skill) => skill.name),
    ).toEqual(["release-notes", "summarize"]);
  });

  it("runs the runtime in the mode that asks before commands", async () => {
    expect((await evalTurn()).permissionMode).toBe("allow-edits");
  });

  it("runs a command freely before a server skill is in use", async () => {
    const forwarded = await sendCommand(await evalTurn());
    expect(runtime.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
      approvalId: "approval-cmd",
      approved: true,
    });
    expect(forwarded.map((part) => part.type)).toEqual(["tool-call"]);
  });

  it("refuses a command in an eval while a picked server skill is in use", async () => {
    const forwarded = await sendCommand(
      await evalTurn({ messages: [PICKED, ASK] }),
    );
    expect(runtime.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
      approvalId: "approval-cmd",
      approved: false,
      reason: COMMAND_REFUSED_IN_USE.nobody,
    });
    expect(
      forwarded.some((part) => part.type === "tool-approval-request"),
    ).toBe(false);
  });
});

describe("a harness turn without one", () => {
  it("keeps the runtime's own mode and offers no skill tools", async () => {
    const agent = await evalTurn({ pinnedHarnessSkills: [] });
    expect(agent.permissionMode).toBe("allow-all");
    expect(agent.tools ?? {}).not.toHaveProperty("loadSkill");
    expect(agent.instructions).toBe("You are Codex.");
  });
});
