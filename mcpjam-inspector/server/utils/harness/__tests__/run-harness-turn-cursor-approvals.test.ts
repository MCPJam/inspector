/**
 * Cursor CLI approvals, through the real runner.
 *
 * The runtime here is a scripted HarnessV1 runtime that emits what
 * `@ai-sdk/harness-acp` 1.0.60 sends the host for a Cursor MCP call that needs
 * permission (order measured in probe D5): the raw ACP updates first,
 * unbuffered, then the call itself with an empty input (the translator still
 * holds its updates), then the approval request. It is wrapped exactly as the
 * Cursor adapter and the runner wrap it. Like the bridge, it numbers its
 * prompts per process (`acp-permission-<n>`) and answers its pending prompt by
 * approval id alone; the agent double saves the paused call the way the
 * framework's `suspendTurn` does, and answers a streamed prompt that reuses a
 * delivered approval id, as `runPrompt` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToModelMessages } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
  HarnessV1,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";

const ACP_CALL = "tool_1a6267b0-6e38-4177-8159-3c60093864e";
const ARGS = { text: "alpha", options: { tags: ["b", "a"], count: 2 } };
const script = vi.hoisted(() => ({
  key: "",
  /** The call Cursor asks permission for next. */
  call: { id: "", toolName: "", args: {} as unknown },
  /** A bridge process: its prompt counter restarts with it. */
  bridge: { generation: 1, prompts: 0 },
  /** The prompt the live bridge is waiting on. */
  waiting: undefined as { approvalId: string; call: { id: string; toolName: string; args: unknown } } | undefined,
  /** Calls Cursor ran after hearing an approval. */
  executions: [] as string[],
  /** A prompt the resumed turn raises before it hears anything (a rerun). */
  rerun: undefined as { id: string; toolName: string; args: unknown } | undefined,
  delivered: [] as Array<{ approvalId: string; approved: boolean }>,
  continueSawBinding: undefined as boolean | undefined,
  recorded: () => false,
}));

/** What acp 1.0.60 emits to the host before the turn pauses. */
function permissionParts(
  key: string,
  call: { id: string; toolName: string; args: unknown },
  approvalId: string,
): HarnessV1StreamPart[] {
  const rawInput = { providerIdentifier: key, toolName: call.toolName, args: call.args };
  return [
    { type: "raw", rawValue: { sessionUpdate: "tool_call", toolCallId: call.id, title: "MCP: tool", kind: "other", status: "pending", rawInput: {} } },
    { type: "raw", rawValue: { sessionUpdate: "tool_call_update", toolCallId: call.id, title: `${key}: ${call.toolName}`, rawInput } },
    { type: "raw", rawValue: { sessionUpdate: "tool_call_update", toolCallId: call.id, status: "in_progress" } },
    { type: "tool-call", toolCallId: call.id, toolName: `acp_tool_${call.id}`, input: "{}", providerExecuted: true },
    { type: "tool-approval-request", approvalId, toolCallId: call.id },
  ] as HarnessV1StreamPart[];
}

const scriptedRuntime = vi.hoisted(() => (): HarnessV1 => ({
  specificationVersion: "harness-v1",
  harnessId: "cursor",
  doStart: async () => ({
    sessionId: "acp-session-1",
    doPromptTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
      const approvalId = `acp-permission-${++script.bridge.prompts}`;
      script.waiting = { approvalId, call: { ...script.call } };
      for (const part of permissionParts(script.key, script.call, approvalId)) emit(part);
      return { done: Promise.resolve() };
    },
    doContinueTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
      // The bridge answers Cursor only now; the binding must already exist.
      script.continueSawBinding = script.recorded();
      if (script.rerun) {
        // The bridge lost its process: the rerun asks again, numbered from 1.
        const approvalId = `acp-permission-${++script.bridge.prompts}`;
        for (const part of permissionParts(script.key, script.rerun, approvalId)) emit(part);
        return { done: Promise.resolve() };
      }
      // Cursor's pending prompt takes whatever decision carries its approval id.
      const waiting = script.waiting;
      const decision = script.delivered.find((entry) => entry.approvalId === waiting?.approvalId);
      if (waiting && decision?.approved) {
        script.waiting = undefined;
        script.executions.push(waiting.call.id);
        emit({ type: "tool-result", toolCallId: waiting.call.id, toolName: waiting.call.toolName, result: { success: true } } as HarnessV1StreamPart);
      }
      emit({ type: "finish", finishReason: "stop" } as HarnessV1StreamPart);
      return { done: Promise.resolve() };
    },
  }),
}) as unknown as HarnessV1);

const agentState = vi.hoisted(() => ({ saved: null as Record<string, unknown> | null, fence: false }));
vi.mock("@ai-sdk/harness/agent", async (original) => ({
  ...(await original<typeof import("@ai-sdk/harness/agent")>()),
  HarnessAgent: class {
    private session?: {
      doPromptTurn: (options: { emit: (part: unknown) => void }) => Promise<{ done: Promise<void> }>;
      doContinueTurn: (options: { emit: (part: unknown) => void }) => Promise<{ done: Promise<void> }>;
    };
    private parts: Array<Record<string, unknown>> = [];
    constructor(private readonly opts: { harness: { doStart: (options: unknown) => Promise<never> } }) {}
    createSession = vi.fn(async () => {
      this.session = await this.opts.harness.doStart({});
      return {
        sessionId: "acp-session-1",
        // As the framework saves it: the adapter's state plus the pending approval.
        suspendTurn: async () => {
          const request = this.parts.findLast((part) => part.type === "tool-approval-request");
          const call = this.parts.findLast(
            (part) => part.type === "tool-call" && part.toolCallId === request?.toolCallId,
          );
          return {
            type: "continue-turn",
            harnessId: "cursor",
            specificationVersion: "harness-v1",
            data: { bridge: { port: 4100, token: `generation-${script.bridge.generation}`, sandboxId: "sandbox-1" } },
            ...(request && call
              ? {
                  pendingToolApprovals: [
                    {
                      approvalId: request.approvalId,
                      toolCallId: request.toolCallId,
                      toolName: call.toolName,
                      input: call.input,
                      kind: "builtin",
                      providerExecuted: true,
                    },
                  ],
                }
              : {}),
          };
        },
        detach: async () => ({ type: "resume-session", data: {} }),
        destroy: async () => {},
        stop: async () => ({}),
      };
    });
    private async drive(method: "doPromptTurn" | "doContinueTurn") {
      const parts: Array<Record<string, unknown>> = [];
      const control = await this.session![method]({ emit: (part) => parts.push(part as Record<string, unknown>) });
      await control.done;
      this.parts = parts;
      // `runPrompt` answers a streamed prompt that reuses a delivered approval id.
      for (const part of parts) {
        const decision = script.delivered.find((entry) => entry.approvalId === part.approvalId);
        if (method === "doContinueTurn" && part.type === "tool-approval-request" && decision?.approved)
          script.executions.push(String(part.toolCallId));
      }
      // A stream error fails the turn's result, as `runPrompt` settles it.
      const failure = parts.find((part) => part.type === "error");
      return {
        fullStream: (async function* () {
          for (const part of parts) if (part !== failure) yield part;
        })(),
        get text() {
          return failure ? Promise.reject(failure.error) : Promise.resolve("");
        },
      };
    }
    stream = vi.fn(async () => this.drive("doPromptTurn"));
    continueStream = vi.fn(async (options: { toolApprovalContinuations: Array<{ approvalId: string; approved: boolean }> }) => {
      script.delivered = options.toolApprovalContinuations;
      return this.drive("doContinueTurn");
    });
  },
}));

const harnessState = vi.hoisted(() => ({ createHarness: vi.fn() }));
vi.mock("../registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry.js")>();
  const { withAcpPermissionCallInput } = await import("../acp-permission-input.js");
  const cursor = actual.getHarnessAdapter("cursor");
  harnessState.createHarness.mockImplementation(() =>
    withAcpPermissionCallInput(scriptedRuntime()),
  );
  return {
    ...actual,
    getHarnessAdapter: vi.fn(() => ({ ...cursor, createHarness: harnessState.createHarness })),
  };
});

vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => []),
  convexGetEnvironmentSecretSelection: vi.fn(async () => ["secret-cursor"]),
  convexListSecretsForRuntimeExecution: vi.fn(async () => []),
  convexMarkSecretsDelivered: vi.fn(async () => ({ marked: 0 })),
}));
vi.mock("../../computers/control-plane-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../computers/control-plane-client.js")>()),
  getBoxCredentialAvailability: vi.fn(async () => ({ ok: false, status: 404 })),
}));
vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({ computerId: "computer-1", sandboxId: "sandbox-1" })),
}));
vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));
vi.mock("../runtime-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-skills.js")>()),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));
vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
  appendManagedSkills: vi.fn(async () => {}),
}));
vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
  // The backend's lane fence: with `approvalCalls`, a decision must name a
  // paused call by approval id and ACP call id (an older backend checks ids).
  claimHarnessSessionState: vi.fn(async (request: { approvalCalls?: Array<{ approvalId: string; toolCallId: string }> }) => {
    const resumeState = agentState.saved?.resumeState as
      | { pendingToolApprovals?: Array<{ approvalId: string; toolCallId: string }> }
      | undefined;
    const fenced = agentState.fence && request.approvalCalls?.some(
      (call) => !resumeState?.pendingToolApprovals?.some(
        (paused) => paused.approvalId === call.approvalId && paused.toolCallId === call.toolCallId,
      ),
    );
    if (fenced) return { ok: false, status: 409, error: "harness_approval_pending" };
    return {
      ok: true,
      laneId: "lane-1",
      leaseId: "lease-1",
      stateVersion: 1,
      state: agentState.saved,
      fingerprintChanged: false,
    };
  }),
  commitHarnessSessionState: vi.fn(async (input: Record<string, unknown>) => {
    agentState.saved = input;
    return true;
  }),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
}));
vi.mock("../harness-model-broker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-model-broker.js")>()),
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => ({ ok: true })),
}));

import { runHarnessTurn } from "../run-harness-turn";
import { harnessServerKeyToName } from "../mcp-config";
import { setManagerOrganization } from "../../mcp-connections";
import { approvalArgsDigest } from "../forwarding/approval-bindings";
import { claimHarnessSessionState } from "../harness-session-state";

const operations: Array<Record<string, unknown>> = [];
const bindings = { recorded: true as boolean };
script.recorded = () =>
  operations.some((operation) => operation.kind === "record_approval");

function manager() {
  const value = {
    getServerConfig: vi.fn(() => ({ url: "https://server.test/mcp", timeout: 300_000 })),
    getInitializationInfo: vi.fn(() => ({
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
      clientCapabilities: {},
    })),
  };
  setManagerOrganization(value as never, "org_1");
  return value;
}

function turn(messages: ModelMessage[]) {
  return {
    messages,
    modelId: "cursor/auto",
    provider: "cursor",
    systemPrompt: "Use tools.",
    authHeader: "Bearer test",
    projectId: "p1",
    environmentId: "env-1",
    runtimeSecrets: [{ name: "CURSOR_API_KEY", value: "key_live_abc", updatedAt: 1 }],
    mcpClientManager: manager(),
    selectedServers: ["srv-a"],
    harnessMcpProxy: { plane: "web-authorized", mode: "direct", publicBaseUrl: "https://inspector.test" },
    respectToolVisibility: false,
    requireToolApproval: true,
    sourceType: "direct",
    harness: "cursor",
    hostId: "host-1",
    chatSessionId: "chat-1",
    onConversationComplete: vi.fn(async () => ({ outcome: "saved" })),
  };
}

async function body(messages: ModelMessage[]) {
  const result = await runHarnessTurn(turn(messages) as never, "ui");
  return result.response!.text();
}

function chunks(wire: string): Array<Record<string, unknown>> {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
}

/** The user's answer, as the Playground sends back the call the pause showed. */
function answer(paused: string, approved: boolean, input?: unknown) {
  const shown = chunks(paused).find((chunk) => chunk.type === "tool-input-available")!;
  const request = chunks(paused).find((chunk) => chunk.type === "tool-approval-request")!;
  return convertToModelMessages([
    { id: "user-1", role: "user", parts: [{ type: "text", text: "write it" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: String(shown.toolName),
          toolCallId: String(request.toolCallId),
          input: input ?? shown.input,
          state: "approval-responded",
          providerExecuted: true,
          approval: { id: String(request.approvalId), approved },
        },
      ],
    },
  ]);
}

beforeEach(() => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "org_1");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-service-token-for-tests");
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "test-harness-proxy-secret-32-chars";
  script.key = Object.keys(harnessServerKeyToName([{ name: "srv-a" }]))[0]!;
  script.call = { id: ACP_CALL, toolName: "fast_write", args: ARGS };
  script.bridge = { generation: 1, prompts: 0 };
  script.waiting = undefined;
  script.executions.length = 0;
  script.rerun = undefined;
  script.delivered = [];
  script.continueSawBinding = undefined;
  agentState.saved = null;
  agentState.fence = false;
  operations.length = 0;
  bindings.recorded = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const request = JSON.parse(String(init?.body ?? "{}"));
      if (path === "/web/harness/forwarding/start")
        return Response.json({
          ok: true,
          runId: request.runId,
          expiresAt: Date.now() + 15 * 60_000,
          delivery: "e2b-network-transform",
          forwardingOwners: [
            { kind: "chat", userId: "user_convex_1", serverId: "srv-a", harnessSessionId: "lane-1" },
          ],
          forwardingOrigin: "https://inspector.test",
        });
      if (path === "/web/harness/session-grant/start")
        return Response.json({
          ok: true,
          runId: request.runId,
          expiresAt: Date.now() + 15 * 60_000,
          delivery: "e2b-network-transform",
          grantOrigin: "https://inspector.test",
        });
      if (path === "/web/harness/session-state/bind-turn")
        return Response.json({ ok: true, bound: true, laneId: "lane-1", handles: { "srv-a": "handle" } });
      if (path === "/internal/v1/harness-forwarding/executions") {
        const operation = request.operation as Record<string, unknown>;
        operations.push(operation);
        if (operation.kind === "bind_policy") return Response.json({ bound: true });
        if (operation.kind === "record_approval")
          return Response.json(
            bindings.recorded ? { recorded: true } : { recorded: false, reason: "call_ended" },
          );
        if (operation.kind === "void_approvals") return Response.json({ voided: 1 });
        return Response.json([]);
      }
      return Response.json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const recorded = () => operations.filter((operation) => operation.kind === "record_approval");

describe("a Cursor MCP call that needs approval, on the forwarded route", () => {
  it("pauses on Cursor's own prompt, naming the server's tool, and answers nothing for the user", async () => {
    const wire = await body([{ role: "user", content: "write it" }]);
    expect(wire).toContain("tool-approval-request");
    expect(chunks(wire).find((chunk) => chunk.type === "tool-input-available")).toMatchObject({
      toolCallId: ACP_CALL,
      toolName: "fast_write",
      input: { providerIdentifier: script.key, toolName: "fast_write", args: ARGS },
    });
    expect(script.executions).toEqual([]);
    expect(recorded()).toEqual([]);
    expect(agentState.saved).toMatchObject({ awaitingApproval: true });
  });

  it("binds the approval to one request before Cursor hears it, and voids it when the call ends", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    await body(await answer(paused, true));
    // Each turn has its own grant; the binding lives on the turn that resumes.
    const [first, start] = operations.filter((operation) => operation.kind === "bind_policy");
    expect(start!.turnId).not.toBe(first!.turnId);
    expect(recorded()).toEqual([
      {
        kind: "record_approval",
        turnId: start!.turnId,
        acpToolCallId: ACP_CALL,
        toolName: "fast_write",
        argsDigest: approvalArgsDigest(ARGS),
      },
    ]);
    expect(script.continueSawBinding).toBe(true);
    expect(operations.filter((operation) => operation.kind === "void_approvals")).toEqual([
      expect.objectContaining({ acpToolCallId: ACP_CALL, turnId: start!.turnId }),
    ]);
  });

  it("records nothing for a denied call", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    await body(await answer(paused, false));
    expect(recorded()).toEqual([]);
  });

  it("refuses a decision for a call that already ended, before Cursor hears it", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    bindings.recorded = false;
    const wire = await body(await answer(paused, true));
    expect(wire).toContain("The session for this approval is no longer available");
    expect(script.continueSawBinding).toBeUndefined();
  });

  it("refuses a late decision once its paused turn is gone (P3), recording nothing", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    // Stop, then a new turn: the paused continuation no longer exists.
    agentState.saved = null;
    const wire = await body(await answer(paused, true));
    expect(wire).toContain("The session for this approval is no longer available");
    expect(recorded()).toEqual([]);
    expect(script.continueSawBinding).toBeUndefined();
  });

  it("binds the call the server saved, not the browser's copy of it", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    // A tampered page sends other arguments back with its answer.
    const forged = { providerIdentifier: script.key, toolName: "fast_write", args: { text: "omega" } };
    await body(await answer(paused, true, forged));
    expect(recorded()).toEqual([
      expect.objectContaining({ acpToolCallId: ACP_CALL, toolName: "fast_write", argsDigest: approvalArgsDigest(ARGS) }),
    ]);
  });

  it("never answers a prompt a restarted bridge numbered like the decided one", async () => {
    const paused = await body([{ role: "user", content: "write it" }]);
    // The bridge lost its process while paused: the rerun asks again, numbered from 1.
    script.bridge = { generation: 2, prompts: 0 };
    script.rerun = { id: "tool_rerun", toolName: "delete_rows", args: { id: 7 } };
    const wire = await body(await answer(paused, true));
    expect(script.executions).toEqual([]);
    expect(wire).toContain("The session for this approval is no longer available");
  });
});

describe("one approval across a bridge restart and two tabs", () => {
  /** Turn 1 pauses on Cursor's first prompt, tab A approves it, and it runs. */
  async function ranOnce() {
    script.call = { id: "tool_A", toolName: "delete_rows", args: { id: 7 } };
    const first = await body([{ role: "user", content: "delete row 7" }]);
    await body(await answer(first, true));
    expect(script.executions).toEqual(["tool_A"]);
    // A later turn is stopped, so the bridge restarts and numbers prompts from 1.
    script.bridge = { generation: 2, prompts: 0 };
    script.call = { id: "tool_B", toolName: "delete_rows", args: { id: 7 } };
    const second = await body([{ role: "user", content: "delete row 7 again" }]);
    expect(chunks(second).find((chunk) => chunk.type === "tool-approval-request")).toMatchObject({
      approvalId: "acp-permission-1",
      toolCallId: "tool_B",
    });
    operations.length = 0;
    return { first, second };
  }

  it.each([
    ["forwarded route", "org_1", false],
    ["signed proxy", "another-org", false],
    ["forwarded route, behind the lane fence", "org_1", true],
    ["signed proxy, behind the lane fence", "another-org", true],
  ])("runs once per approval, and refuses the stale tab's approval (%s)", async (_route, enrolled, fence) => {
    vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", enrolled);
    agentState.fence = fence;
    const { first, second } = await ranOnce();
    // Tab B still shows turn 1's prompt, numbered acp-permission-1 too, and approves it.
    const stale = await body(await answer(first, true));
    expect(stale).toContain("The session for this approval is no longer available");
    // The claim names the call too, so the lane fence refuses it before the pause is taken.
    expect(vi.mocked(claimHarnessSessionState).mock.calls.at(-1)![0]).toMatchObject({
      approvalIds: ["acp-permission-1"],
      approvalCalls: [{ approvalId: "acp-permission-1", toolCallId: "tool_A" }],
    });
    expect(recorded()).toEqual([]);
    expect(script.executions).toEqual(["tool_A"]);
    // Tab A answers the prompt that is actually waiting: it runs once.
    await body(await answer(second, true));
    expect(script.executions).toEqual(["tool_A", "tool_B"]);
    expect(recorded().map((operation) => operation.acpToolCallId)).toEqual(
      enrolled === "org_1" ? ["tool_B"] : [],
    );
  });
});
