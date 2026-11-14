/**
 * GitHub Copilot CLI outside the warm Playground chat: the cold path evals,
 * swarms and User Testing take. Mostly a swarm journey on a client that runs
 * Copilot as its agent loop with one MCP server; the same turn in evals and
 * User Testing, and the dedicated Copilot CLI client, are checked too.
 *
 * The registry's real adapter builds the runtime. The harness agent is scripted
 * at the seam the other turn tests use, and it runs the MCP tool the turn hands
 * it, the way the agent runs a host tool the bridge asks for. A backend
 * stand-in keeps what the turn persists and hands it to the next turn's claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

type Part = Record<string, unknown> & { type?: string };
type Step = Part | ((tools: Record<string, ToolLike>) => Promise<Part[]>);
type ToolLike = {
  execute: (input: unknown, options: Record<string, unknown>) => Promise<unknown>;
};

const agent = vi.hoisted(() => ({
  script: [] as Array<unknown>,
  /** Each constructed agent's settings, and each `createSession` request. */
  settings: [] as Array<Record<string, unknown>>,
  sessionRequests: [] as unknown[],
  session: {
    sessionId: "copilot-session-1",
    detach: vi.fn(async () => ({
      type: "resume-session",
      harnessId: "copilot-cli",
      specificationVersion: "harness-v1",
      // The live bridge the turn ran on; the next turn starts its own.
      data: {
        threadId: "copilot-thread-1",
        bridge: { port: 39271, token: "t", lastSeenEventId: 6, sandboxId: "sandbox-1" },
      },
    })),
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    suspendTurn: vi.fn(async () => ({ type: "continue-turn" })),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(private readonly settings: Record<string, unknown>) {
      agent.settings.push(settings);
    }
    createSession = vi.fn(async (request?: unknown) => {
      agent.sessionRequests.push(request);
      const onSandboxSession = this.settings.onSandboxSession as (args: {
        session: unknown;
        sessionWorkDir: string;
      }) => Promise<void>;
      await onSandboxSession({
        session: {
          getPortEndpoint: async () => ({ url: "ws://bridge.test" }),
          readTextFile: async () => null,
          writeTextFile: async () => {},
          run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
        sessionWorkDir: "/home/user/work",
      });
      return agent.session;
    });
    stream = vi.fn(async () => {
      const tools = (this.settings.tools ?? {}) as Record<string, ToolLike>;
      return {
        fullStream: (async function* () {
          for (const step of agent.script as Step[]) {
            if (typeof step === "function") yield* await step(tools);
            else yield step;
          }
        })(),
        text: Promise.resolve(""),
      };
    });
    continueStream = this.stream;
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

/** The backend lane: what the last persisted turn committed. */
const lane = vi.hoisted(() => ({
  version: 0,
  state: null as null | {
    harnessSessionId: string;
    resumeState: unknown;
    computerId: string;
  },
}));

vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
  claimHarnessSessionState: vi.fn(async () => ({
    ok: true,
    leaseId: "lease-1",
    laneId: "lane-1",
    stateVersion: lane.version,
    state: lane.state,
    fingerprintChanged: false,
  })),
  commitHarnessSessionState: vi.fn(async () => true),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
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

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

import { runHarnessTurn } from "../run-harness-turn";
import { getHarnessAdapter } from "../registry.js";
import { releaseHarnessSessionState } from "../harness-session-state.js";

const ORDER = { content: [{ type: "text", text: "Order 42 shipped on Monday." }] };

const lookupOrder = vi.fn(async (_input: unknown) => ORDER);

/** One server with one tool, as the manager hands it to a harness turn. */
const manager = {
  getServerConfig: vi.fn((id: string) =>
    id === "orders" ? { url: "https://orders.example/mcp" } : undefined,
  ),
  getToolsForAiSdk: vi.fn(async () => ({
    lookup_order: {
      description: "Look up an order",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      execute: lookupOrder,
    },
  })),
  getInitializationInfo: vi.fn(() => undefined),
};

/** What the swarm runner's save (the ingest) received, turn by turn. */
const saved: Array<{ transcript: ModelMessage[]; commit: unknown }> = [];

function turn(text: string, overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    modelId: "openai/gpt-5.5",
    provider: "openai",
    systemPrompt: "You are a support agent.",
    authHeader: "Bearer test",
    projectId: "project-1",
    chatSessionId: "chat-1",
    sourceType: "swarm",
    journeyRunId: "journey-1",
    hostId: "host-vscode",
    // A client that runs Copilot as its agent loop and keeps MCPJam's MCP client.
    harness: "copilot-cli",
    agentLoop: "copilot-cli",
    mcpClientManager: manager,
    selectedServers: ["orders"],
    harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
    requireToolApproval: false,
    approvalMode: "auto-deny",
    onConversationComplete: async (
      transcript: ModelMessage[],
      _trace: unknown,
      commit?: { harnessSessionId: string; resumeState: unknown; computerId: string },
    ) => {
      saved.push({ transcript, commit });
      if (commit) {
        lane.state = {
          harnessSessionId: commit.harnessSessionId,
          resumeState: commit.resumeState,
          computerId: commit.computerId,
        };
        lane.version += 1;
      }
      return { outcome: "saved" as const };
    },
    ...overrides,
  };
}

/** The runtime asks for the order tool, gets its result, and answers. */
const answersWithTheTool: Step[] = [
  { type: "stream-start" },
  async (tools) => {
    const name = Object.keys(tools).find((key) => key.endsWith("lookup_order"));
    if (!name) throw new Error(`no order tool among ${Object.keys(tools).join(", ")}`);
    const input = { id: "42" };
    const output = await tools[name]!.execute(input, {
      toolCallId: "call_1",
      messages: [],
    });
    return [
      { type: "tool-call", toolCallId: "call_1", toolName: name, input },
      { type: "tool-result", toolCallId: "call_1", toolName: name, input, output },
    ];
  },
  { type: "text-start", id: "m1" },
  { type: "text-delta", id: "m1", delta: "Order 42 shipped on Monday." },
  { type: "text-end", id: "m1" },
  {
    type: "finish-step",
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  },
  { type: "finish", finishReason: "stop" },
];

const run = (text: string, overrides?: Record<string, unknown>) =>
  runHarnessTurn(turn(text, overrides) as never, "none");

describe("GitHub Copilot CLI outside the warm Playground chat", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    agent.script = answersWithTheTool;
    agent.settings.length = 0;
    agent.sessionRequests.length = 0;
    saved.length = 0;
    lane.version = 0;
    lane.state = null;
    lookupOrder.mockClear();
    vi.mocked(releaseHarnessSessionState).mockClear();
    for (const fn of Object.values(agent.session)) {
      if (typeof fn === "function") vi.mocked(fn).mockClear();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs the turn on Copilot's own runtime and executes its MCP tool call", async () => {
    const createHarness = vi.spyOn(getHarnessAdapter("copilot-cli"), "createHarness");

    const result = await run("Where is order 42?");

    expect(result.aborted).toBe(false);
    // The runtime the agent drove is the CLI's retained bridge, with the
    // model proxy settings its bridge refuses to start without.
    expect(createHarness).toHaveBeenCalledOnce();
    expect(createHarness.mock.calls[0]![0]).toMatchObject({
      auth: {
        OPENAI_BASE_URL: expect.any(String),
        COPILOT_MODEL_PROXY_PLACEHOLDER: expect.any(String),
      },
    });
    expect(agent.settings[0]!.harness).toMatchObject({ harnessId: "copilot-cli" });
    // MCPJam's client ran the call against the server, with the model's input.
    expect(lookupOrder).toHaveBeenCalledOnce();
    expect(lookupOrder.mock.calls[0]![0]).toEqual({ id: "42" });
  });

  it.each([
    ["evals", { sourceType: "eval", evalIterationId: "iteration-1", journeyRunId: undefined }],
    ["User Testing", { sourceType: "scenario", scenarioId: "scenario-1", journeyRunId: undefined }],
  ])("runs the same turn in %s", async (_surface, source) => {
    const result = await run("Where is order 42?", source);

    expect(result.aborted).toBe(false);
    expect(agent.settings[0]!.harness).toMatchObject({ harnessId: "copilot-cli" });
    expect(lookupOrder).toHaveBeenCalledOnce();
  });

  it("runs the dedicated Copilot CLI client when no server is selected", async () => {
    agent.script = [
      { type: "text-delta", delta: "Hello." },
      { type: "finish", finishReason: "stop" },
    ];

    const result = await run("Hi", { agentLoop: undefined, selectedServers: [] });

    expect(result.aborted).toBe(false);
    expect(agent.settings[0]!.harness).toMatchObject({ harnessId: "copilot-cli" });
  });

  it("refuses the dedicated client with servers before its runtime starts", async () => {
    // It reaches servers only through its own MCP client, which a journey
    // never forwards.
    const onEngineError = vi.fn();

    await run("Where is order 42?", { agentLoop: undefined, onEngineError });

    expect(onEngineError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "setup",
        message: expect.stringContaining(
          "GitHub Copilot CLI calls MCP servers only through its own client",
        ),
      }),
    );
    expect(agent.settings).toHaveLength(0);
    expect(lookupOrder).not.toHaveBeenCalled();
  });

  it("persists the transcript, the tool result and the session together", async () => {
    await run("Where is order 42?");

    expect(saved).toHaveLength(1);
    const { transcript, commit } = saved[0]!;
    const parts = transcript.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    ) as Array<Record<string, unknown>>;
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-call", toolCallId: "call_1", input: { id: "42" } }),
        expect.objectContaining({ type: "tool-result", toolCallId: "call_1" }),
        expect.objectContaining({ type: "text", text: "Order 42 shipped on Monday." }),
      ]),
    );
    expect(commit).toMatchObject({
      ownerType: "swarm-chat",
      chatSessionId: "chat-1",
      harnessId: "copilot-cli",
      harnessSessionId: "copilot-session-1",
      resumeState: { data: { threadId: "copilot-thread-1" } },
    });
    // Detached, not torn down: the session is the next turn's to resume.
    expect(agent.session.detach).toHaveBeenCalledOnce();
    expect(agent.session.destroy).not.toHaveBeenCalled();
  });

  it("resumes the same Copilot session on the next turn", async () => {
    await run("Where is order 42?");
    agent.script = [
      { type: "text-delta", delta: "It arrives Thursday." },
      { type: "finish", finishReason: "stop" },
    ];

    const second = await run("When does it arrive?");

    expect(second.aborted).toBe(false);
    // The first turn started fresh; the second resumes the persisted thread on
    // a bridge of its own, never the first turn's address.
    expect(agent.sessionRequests[0]).toBeUndefined();
    expect(agent.sessionRequests[1]).toEqual({
      sessionId: "copilot-session-1",
      resumeFrom: {
        type: "resume-session",
        harnessId: "copilot-cli",
        specificationVersion: "harness-v1",
        data: { threadId: "copilot-thread-1" },
      },
    });
    expect(saved).toHaveLength(2);
    expect(lane.version).toBe(2);
  });

  it("a Stop mid-turn aborts and persists no session to resume", async () => {
    const stop = new AbortController();
    agent.script = [
      { type: "text-delta", delta: "Looking that up" },
      async () => {
        stop.abort();
        return [{ type: "abort" }];
      },
    ];

    const result = await run("Where is order 42?", { abortSignal: stop.signal });

    expect(result.aborted).toBe(true);
    expect(lookupOrder).not.toHaveBeenCalled();
    expect(saved.every(({ commit }) => commit === undefined)).toBe(true);
    expect(lane.state).toBeNull();
    // Torn down and the lane handed back, so the next turn starts clean.
    expect(agent.session.destroy).toHaveBeenCalledOnce();
    expect(agent.session.detach).not.toHaveBeenCalled();
    expect(releaseHarnessSessionState).toHaveBeenCalled();
  });
});
