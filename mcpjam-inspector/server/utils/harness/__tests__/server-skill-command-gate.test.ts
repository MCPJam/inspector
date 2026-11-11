/**
 * MCPJam's gate on a harness runtime's commands while a server's skill is in
 * use: what it answers each request with, who it asks, and how it answers on
 * the runtime's own session.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HarnessV1,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import {
  COMMAND_GATE_PERMISSION_MODE,
  COMMAND_REFUSED_IN_USE,
  commandGateAnswerer,
  commandGateDecision,
  commandGateTurn,
  isCommandRequest,
  withServerSkillCommandGate,
  type CommandGateState,
} from "../server-skill-command-gate.js";

const call = (name: string, nativeName?: string) => ({
  name,
  ...(nativeName ? { nativeName } : {}),
  input: {},
});
const CLAUDE_BASH = call("bash", "Bash");
const CLAUDE_MONITOR = call("Monitor", "Monitor");
const CLAUDE_WRITE = call("write", "Write");
const CODEX_COMMAND = call("bash", "exec_command");
const CODEX_PATCH = call("fileChange", "apply_patch");
const MCP_TOOL = call("mcp__docs__search");

const state = (overrides: Partial<CommandGateState>): CommandGateState => ({
  inUse: false,
  switchOn: false,
  answerer: "member",
  ...overrides,
});

describe("what counts as a command", () => {
  it.each([
    ["Claude Code's Bash", CLAUDE_BASH],
    ["Claude Code's Monitor", CLAUDE_MONITOR],
    ["a Codex command", CODEX_COMMAND],
    ["a tool the gate does not know", call("Task", "Task")],
    ["a request with no call", undefined],
  ])("%s is a command", (_label, request) => {
    expect(isCommandRequest(request)).toBe(true);
  });

  it.each([
    ["Claude Code's Write", CLAUDE_WRITE],
    ["Claude Code's NotebookEdit", call("NotebookEdit", "NotebookEdit")],
    ["a Codex patch", CODEX_PATCH],
    ["an MCP server's tool", MCP_TOOL],
  ])("%s is not", (_label, request) => {
    expect(isCommandRequest(request)).toBe(false);
  });
});

describe("the gate's answer", () => {
  it.each([
    // Nothing in use, approval off: the gate asks nobody.
    [CLAUDE_BASH, state({}), "approve"],
    [CODEX_PATCH, state({}), "approve"],
    [CLAUDE_BASH, state({ answerer: "nobody" }), "approve"],
    // A server skill in use: a member is asked about commands only.
    [CLAUDE_BASH, state({ inUse: true }), "ask"],
    [CODEX_COMMAND, state({ inUse: true }), "ask"],
    [CODEX_PATCH, state({ inUse: true }), "approve"],
    [MCP_TOOL, state({ inUse: true }), "approve"],
    // …and a turn nobody can answer, or a guest's, refuses them.
    [CODEX_COMMAND, state({ inUse: true, answerer: "nobody" }), "deny"],
    [CODEX_PATCH, state({ inUse: true, answerer: "nobody" }), "approve"],
    [CLAUDE_BASH, state({ inUse: true, answerer: "guest" }), "deny"],
    // The approval switch on: every request asks, as on any approval turn.
    [CLAUDE_BASH, state({ switchOn: true }), "ask"],
    [CLAUDE_WRITE, state({ switchOn: true, inUse: true }), "ask"],
    [CLAUDE_WRITE, state({ switchOn: true, answerer: "guest" }), "ask"],
    [CLAUDE_BASH, state({ switchOn: true, inUse: true }), "ask"],
    [
      CLAUDE_BASH,
      state({ switchOn: true, inUse: true, answerer: "guest" }),
      "deny",
    ],
    // Nobody to ask with the switch on (the turn refuses this up front).
    [CLAUDE_WRITE, state({ switchOn: true, answerer: "nobody" }), "deny"],
  ] as const)("%o under %o → %s", (request, gate, expected) => {
    expect(commandGateDecision(request, gate).kind).toBe(expected);
  });

  it("tells the model why it refused, and to go on without commands", () => {
    expect(
      commandGateDecision(
        CODEX_COMMAND,
        state({ inUse: true, answerer: "nobody" }),
      ),
    ).toEqual({ kind: "deny", reason: COMMAND_REFUSED_IN_USE.nobody });
    expect(
      commandGateDecision(
        CLAUDE_BASH,
        state({ inUse: true, answerer: "guest" }),
      ),
    ).toEqual({ kind: "deny", reason: COMMAND_REFUSED_IN_USE.guest });
  });

  it("holds commands in the mode that asks before them and not before edits", () => {
    expect(COMMAND_GATE_PERMISSION_MODE).toBe("allow-edits");
  });
});

describe("who answers", () => {
  const attended = { resumable: true };

  it("is the member watching their own chat", () => {
    expect(commandGateAnswerer({ ...attended, sourceType: "direct" })).toBe(
      "member",
    );
  });

  it("is a guest in a User Testing session", () => {
    expect(
      commandGateAnswerer({
        ...attended,
        sourceType: "scenario",
        scenarioParticipant: true,
      }),
    ).toBe("guest");
  });

  it.each([
    ["an eval", { ...attended, sourceType: "eval" }],
    ["a swarm", { ...attended, sourceType: "swarm" }],
    ["an API or event turn", { ...attended, approvalMode: "auto-deny" }],
    ["a turn with no session to pause", { resumable: false }],
  ])("is nobody on %s", (_label, turn) => {
    expect(commandGateAnswerer(turn)).toBe("nobody");
  });
});

describe("a turn's switch", () => {
  const resumable = { resumable: true };

  it("is on in a hosted turn only when the host asks for approval", () => {
    expect(
      commandGateTurn(
        { requireToolApproval: true },
        { local: false, ...resumable },
      ).switchOn,
    ).toBe(true);
    expect(
      commandGateTurn(
        { requireToolApproval: false },
        { local: false, ...resumable },
      ).switchOn,
    ).toBe(false);
    expect(commandGateTurn({}, { local: false, ...resumable }).switchOn).toBe(
      false,
    );
  });

  it("is off on a local turn only when the host turned approval off", () => {
    // A local turn always asks; MCPJam answers it only with the switch off.
    expect(
      commandGateTurn(
        { requireToolApproval: false },
        { local: true, ...resumable },
      ).switchOn,
    ).toBe(false);
    expect(commandGateTurn({}, { local: true, ...resumable }).switchOn).toBe(
      true,
    );
  });

  it("names who answers from the turn's options", () => {
    expect(
      commandGateTurn(
        { sourceType: "eval", approvalMode: "auto-deny" },
        { local: false, ...resumable },
      ).answerer,
    ).toBe("nobody");
    expect(
      commandGateTurn(
        { sourceType: "direct" },
        { local: false, resumable: false },
      ).answerer,
    ).toBe("nobody");
  });
});

/** A runtime session whose requests the test sends by hand. */
function fakeRuntime() {
  let emit!: (part: HarnessV1StreamPart) => void;
  let finish!: () => void;
  const submitToolApproval = vi.fn(async () => {});
  const control = {
    submitToolResult: vi.fn(async () => {}),
    submitToolApproval,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  } as HarnessV1PromptControl;
  const start = vi.fn(async (options: { emit: typeof emit }) => {
    emit = options.emit;
    return control;
  });
  const harness = {
    doStart: vi.fn(async () => ({
      doPromptTurn: start,
      doContinueTurn: start,
      doStop: vi.fn(),
    })),
  } as unknown as HarnessV1;
  const request = (id: string, toolName: string, nativeName?: string) => {
    emit({
      type: "tool-call",
      toolCallId: id,
      toolName,
      ...(nativeName ? { nativeName } : {}),
      input: "{}",
      providerExecuted: true,
    } as HarnessV1StreamPart);
    emit({
      type: "tool-approval-request",
      approvalId: `approval-${id}`,
      toolCallId: id,
    });
  };
  return { harness, submitToolApproval, request, finish: () => finish() };
}

async function gatedTurn(
  gate: Omit<
    Parameters<typeof withServerSkillCommandGate>[1],
    "pendingApprovalIds"
  > & {
    pendingApprovalIds?: ReadonlySet<string>;
  },
) {
  const runtime = fakeRuntime();
  const forwarded = vi.fn();
  const session = await withServerSkillCommandGate(runtime.harness, {
    pendingApprovalIds: new Set(),
    ...gate,
  }).doStart({} as never);
  const control = await session.doPromptTurn({ emit: forwarded } as never);
  const asked = () =>
    forwarded.mock.calls
      .map(([part]) => part as HarnessV1StreamPart)
      .filter((part) => part.type === "tool-approval-request")
      .map((part) => (part as { approvalId: string }).approvalId);
  return { ...runtime, control, forwarded, asked };
}

describe("the gate on a runtime's session", () => {
  it("refuses a command once a server skill is in use on a turn nobody watches", async () => {
    let inUse = false;
    const turn = await gatedTurn({
      inUse: () => inUse,
      switchOn: false,
      answerer: "nobody",
    });
    turn.request("1", "bash", "exec_command");
    // The model loads a server's skill; the next command is acting on it.
    inUse = true;
    turn.request("2", "bash", "exec_command");
    turn.request("3", "fileChange", "apply_patch");
    turn.finish();
    await turn.control.done;
    expect(turn.submitToolApproval.mock.calls).toEqual([
      [{ approvalId: "approval-1", approved: true }],
      [
        {
          approvalId: "approval-2",
          approved: false,
          reason: COMMAND_REFUSED_IN_USE.nobody,
        },
      ],
      [{ approvalId: "approval-3", approved: true }],
    ]);
    // MCPJam answered every request itself: nothing waits on a person.
    expect(turn.asked()).toEqual([]);
  });

  it("asks the member about a command while a server skill is in use", async () => {
    const turn = await gatedTurn({
      inUse: () => true,
      switchOn: false,
      answerer: "member",
    });
    turn.request("1", "bash", "Bash");
    turn.request("2", "write", "Write");
    turn.finish();
    await turn.control.done;
    expect(turn.asked()).toEqual(["approval-1"]);
    expect(turn.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
      approvalId: "approval-2",
      approved: true,
    });
  });

  it("leaves a request the person already answered to their continuation", async () => {
    const turn = await gatedTurn({
      inUse: () => true,
      switchOn: false,
      answerer: "nobody",
      pendingApprovalIds: new Set(["approval-1"]),
    });
    turn.request("1", "bash", "Bash");
    turn.finish();
    await turn.control.done;
    expect(turn.asked()).toEqual(["approval-1"]);
    expect(turn.submitToolApproval).not.toHaveBeenCalled();
  });

  it("passes every other part through", async () => {
    const turn = await gatedTurn({
      inUse: () => false,
      switchOn: false,
      answerer: "member",
    });
    turn.request("1", "bash", "Bash");
    turn.finish();
    await turn.control.done;
    expect(turn.forwarded.mock.calls.map(([part]) => part.type)).toEqual([
      "tool-call",
    ]);
  });
});
