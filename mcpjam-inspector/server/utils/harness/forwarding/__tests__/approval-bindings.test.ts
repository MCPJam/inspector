/**
 * Cursor CLI approvals bound to one forwarded request (P2, P4), and the
 * argument digest both sides compute (the Inspector from ACP `rawInput.args`,
 * the backend from the forwarded `tools/call` arguments).
 *
 * The backend here is a double that keeps bindings exactly as B5-3 specifies:
 * a request consumes one only when exactly one live binding matches its
 * server, tool and digest, which it computes the way the backend's
 * `lib/approvalArgsDigest.ts` does (canonical JSON built as a string).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessV1, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { executeForwardedOperation, type GateApproval } from "../execution-gate.js";
import type { ExecutionIntent } from "../execution-control.js";
import { attributeCursorToolCall } from "../../mcp-config.js";

const control = vi.hoisted(() => ({
  record: vi.fn(async () => ({ recorded: true }) as { recorded: boolean; reason?: string }),
  void: vi.fn(async () => ({ voided: 1 })),
}));
vi.mock("../execution-control.js", async (original) => ({
  ...(await original<typeof import("../execution-control.js")>()),
  createExecutionControl: () => ({
    recordApproval: control.record,
    voidApprovals: control.void,
  }),
}));

import {
  answerOnlyDecidedCalls,
  approvalArgsDigest,
  createApprovalBindings,
  decidedCalls,
  pausedCallsForDecisions,
} from "../approval-bindings.js";
import { canonicalJson } from "../../../tool-approval-token.js";
import parity from "../../__tests__/fixtures/approval-args-digest-parity-fixtures.json";

const owner = {
  kind: "chat" as const,
  userId: "user",
  serverId: "srv-a",
  harnessSessionId: "lane-1",
};
const KEY = "srv_a";

/** The backend's canonical form (`lib/approvalArgsDigest.ts`), written out. */
function backendCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(backendCanonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .filter((key) => Reflect.get(value, key) !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${backendCanonicalJson(Reflect.get(value, key))}`);
  return `{${entries.join(",")}}`;
}
/** What the backend digests: the arguments inside the receipt's stored params. */
function backendDigest(paramsJson: string): { name: string; argsDigest: string } {
  const stored = JSON.parse(paramsJson) as { value: { name: string; arguments?: unknown } };
  return {
    name: stored.value.name,
    argsDigest: createHash("sha256")
      .update(backendCanonicalJson(stored.value.arguments ?? {}))
      .digest("hex"),
  };
}

/** A backend double holding one turn's bindings, as B5-3 specifies them. */
function backend() {
  const bindings: Array<{ call: string; toolName: string; argsDigest: string; state: "live" | "consumed" }> = [];
  const executions: string[] = [];
  const record = (call: string, toolName: string, argsDigest: string) =>
    bindings.push({ call, toolName, argsDigest, state: "live" });
  const gateControl = {
    prepare: vi.fn(async (intent: ExecutionIntent) => {
      const request = backendDigest(intent.paramsJson);
      const live = bindings.filter(
        (binding) =>
          binding.state === "live" &&
          binding.toolName === request.name &&
          binding.argsDigest === request.argsDigest,
      );
      if (live.length === 1) live[0]!.state = "consumed";
      return {
        executionId: `execution-${intent.rpcId}`,
        state: "prepared" as const,
        replayed: false,
        requireToolApproval: true,
        approved: live.length === 1,
      };
    }),
    read: vi.fn(),
    requestApproval: vi.fn(async (_id: string, nonceHash: string, expiresAt: number) => ({
      nonceHash,
      expiresAt,
      state: "pending",
    })),
    decideApproval: vi.fn(async (_id: string, nonceHash: string, decision: string) => ({
      nonceHash,
      expiresAt: Date.now() + 60_000,
      state: decision,
    })),
    claim: vi.fn(async () => ({ dispatch: true, state: "dispatched" as const })),
    settle: vi.fn(async () => ({ replayed: false, adopted: false })),
  };
  return { bindings, executions, record, gateControl };
}

/** Cursor's `tools/call`, forwarded from the request text Cursor sent. */
function forward(world: ReturnType<typeof backend>, rpcId: number, text: string, ask: GateApproval["ask"]) {
  const params = JSON.parse(text) as Record<string, unknown>;
  return executeForwardedOperation({
    control: world.gateControl as never,
    operation: {
      invocationKey: `invocation-${rpcId}`,
      turnId: "grant-turn",
      rpcId,
      method: "tools/call",
      params,
      paramsPresent: true,
      expiresAt: Date.now() + 60_000,
    },
    approval: { binding: { subject: "forwarding:user", projectId: "p1", chatSessionId: "lane-1" }, ask },
    dispatch: async (settle) => {
      world.executions.push(String(rpcId));
      await settle({ outcome: "success", resultJson: "{}" });
      return "ok";
    },
  });
}
const approveAll: GateApproval["ask"] = async (request) => ({
  approvalId: request.approvalId,
  decision: "approved",
});

beforeEach(() => {
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "forwarding-gate-test-signing-secret");
  control.record.mockClear();
  control.void.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("the argument digest", () => {
  it("agrees with the backend's across key order, number spelling, nesting and escapes", () => {
    // ACP `rawInput.args` as the bridge streams it (JSON text, parsed).
    const acpArgs = JSON.parse(
      '{"z":[1,{"b":true,"a":null}],"a":{"y":2.5,"x":"é\\u200b","n":-0},"m":10}',
    );
    // The same arguments in the `tools/call` Cursor sends, spelled differently.
    const forwarded =
      '{"name":"fast_write","arguments":{"m":1e1,"a":{"n":0,"x":"\\u00e9\\u200b","y":2.50},"z":[1.0,{"a":null,"b":true}]}}';
    const world = backend();
    const ask = vi.fn(approveAll);
    world.record("tool_1", "fast_write", approvalArgsDigest(acpArgs));
    return forward(world, 1, forwarded, ask).then(() => {
      expect(world.bindings[0]!.state).toBe("consumed");
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it("counts absent arguments as an empty object, and any change as another call", () => {
    expect(approvalArgsDigest(undefined)).toBe(approvalArgsDigest({}));
    expect(approvalArgsDigest({ a: { b: [1, 2] } })).not.toBe(
      approvalArgsDigest({ a: { b: [2, 1] } }),
    );
    expect(approvalArgsDigest({ a: 1 })).not.toBe(approvalArgsDigest({ a: "1" }));
  });
});

describe("one approval at Cursor's prompt (P2)", () => {
  it("runs exactly one request, with no second prompt", async () => {
    const world = backend();
    const ask = vi.fn(approveAll);
    world.record("tool_1", "fast_write", approvalArgsDigest({ text: "a" }));
    await forward(world, 1, '{"name":"fast_write","arguments":{"text":"a"}}', ask);
    expect(world.executions).toEqual(["1"]);
    expect(ask).not.toHaveBeenCalled();
    expect(world.gateControl.requestApproval).not.toHaveBeenCalled();
    // A retry of the same call is a new request: its approval is spent.
    await forward(world, 2, '{"name":"fast_write","arguments":{"text":"a"}}', ask);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("never lets an approval for one tool or argument set run another", async () => {
    const world = backend();
    const ask = vi.fn(async (request: { approvalId: string }) => ({
      approvalId: request.approvalId,
      decision: "denied" as const,
    }));
    world.record("tool_1", "fast_write", approvalArgsDigest({ text: "a" }));
    await expect(
      forward(world, 1, '{"name":"slow_write","arguments":{"text":"a"}}', ask),
    ).rejects.toThrow("approval_not_granted");
    await expect(
      forward(world, 2, '{"name":"fast_write","arguments":{"text":"b"}}', ask),
    ).rejects.toThrow("approval_not_granted");
    expect(world.executions).toEqual([]);
    expect(world.bindings[0]!.state).toBe("live");
  });
});

describe("two identical calls in flight (P4)", () => {
  it("asks again when two approvals could match one request, and runs each at most once", async () => {
    const world = backend();
    const ask = vi.fn(approveAll);
    const digest = approvalArgsDigest({ text: "a" });
    world.record("tool_1", "fast_write", digest);
    world.record("tool_2", "fast_write", digest);
    const text = '{"name":"fast_write","arguments":{"text":"a"}}';
    await forward(world, 1, text, ask);
    await forward(world, 2, text, ask);
    expect(world.executions).toEqual(["1", "2"]);
    // Neither binding could be told apart, so the forwarder asked for each.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(world.bindings.map((binding) => binding.state)).toEqual(["live", "live"]);
  });

  it("consumes each binding by itself when the approvals arrive one call at a time", async () => {
    const world = backend();
    const ask = vi.fn(approveAll);
    const text = '{"name":"fast_write","arguments":{"text":"a"}}';
    world.record("tool_1", "fast_write", approvalArgsDigest({ text: "a" }));
    await forward(world, 1, text, ask);
    world.record("tool_2", "fast_write", approvalArgsDigest({ text: "a" }));
    await forward(world, 2, text, ask);
    expect(world.executions).toEqual(["1", "2"]);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("recording the user's answers", () => {
  /** A paused call as the framework saves it: the ACP input is JSON text. */
  const paused = (input: string, approved = true, toolName = "acp_tool_tool_1") => ({
    approvalId: "acp-permission-1",
    toolCallId: "tool_1",
    toolName,
    input,
    approved,
  });
  const mcp = (args: string) =>
    `{"providerIdentifier":${JSON.stringify(KEY)},"toolName":"fast_write","args":${args}}`;
  const bindings = () =>
    createApprovalBindings({
      owners: [owner],
      keyToServerId: { [KEY]: "srv-a" },
      attributeToolCall: attributeCursorToolCall,
      grantTurnId: "grant-turn",
    });

  it("binds an approved MCP call by the server, tool and arguments its input names", async () => {
    await bindings().record([paused(mcp('{"b":2,"a":1}'))]);
    expect(control.record).toHaveBeenCalledExactlyOnceWith(
      "grant-turn",
      "tool_1",
      "fast_write",
      approvalArgsDigest({ a: 1, b: 2 }),
    );
  });

  it("records nothing for a denial or a built-in tool", async () => {
    const approvals = bindings();
    await approvals.record([paused(mcp("{}"), false)]);
    await approvals.record([paused('{"command":"ls"}', true, "shell")]);
    expect(control.record).not.toHaveBeenCalled();
  });

  it("refuses the decision when its call or turn has already ended", async () => {
    control.record.mockResolvedValueOnce({ recorded: false, reason: "call_ended" });
    await expect(bindings().record([paused(mcp("{}"))])).rejects.toThrow(
      "The session for this approval is no longer available",
    );
  });

  it("voids a bound call's binding when the runtime reports the call ended, and only that call's", async () => {
    const approvals = bindings();
    await approvals.record([paused(mcp("{}"))]);
    const runtime = {
      doStart: async () => ({
        doContinueTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
          emit({ type: "tool-result", toolCallId: "other", toolName: "shell", result: {} } as HarnessV1StreamPart);
          emit({ type: "tool-result", toolCallId: "tool_1", toolName: "fast_write", result: { success: true } } as HarnessV1StreamPart);
          return { done: Promise.resolve() };
        },
      }),
    } as unknown as HarnessV1;
    const emit = vi.fn();
    const session = await approvals.voidOnCallEnd(runtime).doStart({} as never);
    await session.doContinueTurn({ emit } as never);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(control.void).toHaveBeenCalledExactlyOnceWith("grant-turn", "tool_1");
  });

  it.each(parity.vectors)("digests the shared vector: $name", async (vector) => {
    await bindings().record([paused(mcp(vector.json))]);
    expect(control.record).toHaveBeenCalledExactlyOnceWith(
      "grant-turn",
      "tool_1",
      "fast_write",
      vector.digest,
    );
    expect(canonicalJson(JSON.parse(vector.json) ?? {})).toBe(vector.canonical);
    expect(backendCanonicalJson(JSON.parse(vector.json) ?? {})).toBe(vector.canonical);
  });
});

describe("which paused call a decision answers", () => {
  /** What the browser sends back: the prompt it showed, and the answer. */
  const shown = (toolCallId: string): ModelMessage[] => [
    { role: "user", content: "delete it" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "delete_rows", input: {} },
        { type: "tool-approval-request", approvalId: "acp-permission-1", toolCallId },
      ],
    } as ModelMessage,
  ];
  const continuations = [{ approvalId: "acp-permission-1", approved: true }];
  /** The continuation the server saved when the turn paused. */
  const saved = (toolCallId: string) => ({
    type: "continue-turn",
    data: { bridge: { token: "generation-2" } },
    pendingToolApprovals: [
      {
        approvalId: "acp-permission-1",
        toolCallId,
        toolName: `acp_tool_${toolCallId}`,
        input: '{"providerIdentifier":"srv_a","toolName":"delete_rows","args":{"id":7}}',
        kind: "builtin",
        providerExecuted: true,
      },
    ],
  });

  it("is the paused call with the decision's approval id and ACP call, with the server's input", () => {
    const decided = decidedCalls(shown("tool_B"), continuations);
    expect(decided).toEqual([{ approvalId: "acp-permission-1", toolCallId: "tool_B" }]);
    expect(pausedCallsForDecisions(saved("tool_B"), decided, continuations)).toEqual([
      expect.objectContaining({
        toolCallId: "tool_B",
        input: '{"providerIdentifier":"srv_a","toolName":"delete_rows","args":{"id":7}}',
        approved: true,
      }),
    ]);
  });

  it("refuses a stale decision for a call the restarted bridge numbered the same", () => {
    const decided = decidedCalls(shown("tool_A"), continuations);
    expect(() => pausedCallsForDecisions(saved("tool_B"), decided, continuations)).toThrow(
      "The session for this approval is no longer available",
    );
    expect(() => pausedCallsForDecisions(null, decided, continuations)).toThrow(
      "The session for this approval is no longer available",
    );
  });

  it("refuses a decision that names no call", () => {
    expect(() =>
      decidedCalls([{ role: "user", content: "delete it" }], continuations),
    ).toThrow("The session for this approval is no longer available");
  });

  it("never answers a renumbered prompt with the decision, only the call it was made for", async () => {
    const decided = [{ approvalId: "acp-permission-1", toolCallId: "tool_A" }];
    const runtime = {
      doStart: async () => ({
        doContinueTurn: async ({ emit }: { emit: (part: HarnessV1StreamPart) => void }) => {
          emit({ type: "tool-approval-request", approvalId: "acp-permission-1", toolCallId: "tool_A" } as HarnessV1StreamPart);
          emit({ type: "tool-approval-request", approvalId: "acp-permission-2", toolCallId: "tool_C" } as HarnessV1StreamPart);
          emit({ type: "tool-approval-request", approvalId: "acp-permission-1", toolCallId: "tool_B" } as HarnessV1StreamPart);
          return { done: Promise.resolve() };
        },
      }),
    } as unknown as HarnessV1;
    const parts: HarnessV1StreamPart[] = [];
    const session = await answerOnlyDecidedCalls(runtime, decided).doStart({} as never);
    await session.doContinueTurn({ emit: (part: HarnessV1StreamPart) => parts.push(part) } as never);
    expect(parts.map((part) => part.type)).toEqual([
      "tool-approval-request",
      "tool-approval-request",
      "error",
    ]);
  });
});
