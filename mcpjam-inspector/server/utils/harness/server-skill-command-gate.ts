/**
 * MCPJam's gate on a harness runtime's commands while a skill from an MCP
 * server is in use (SEP-2640): the harness counterpart of the acting-skill
 * gate on MCPJam's agent (`server-skill-acting-gate.ts`).
 *
 * A hosted turn that offers server skills runs its runtime in a mode that asks
 * before every command ({@link COMMAND_GATE_PERMISSION_MODE}); a local turn
 * always does. MCPJam then answers each request itself
 * ({@link commandGateDecision}):
 *   - with no server skill in use, the call runs, unless the host's approval
 *     switch is on, which asks the person as on any approval turn;
 *   - while one is in use, a member watching their own turn is asked about
 *     every command, and a turn nobody can answer (an eval, a swarm, an API
 *     turn) or a User Testing guest's refuses it.
 * Edits never ask for this reason: the spec gates code execution.
 *
 * Whether a skill is in use is read from the turn's transcript, which
 * `harness-server-skills.ts` keeps: the runtime holds its own context, and
 * MCPJam sees only the conversation and its own tools' results.
 */
import type { HarnessV1, HarnessV1PermissionMode } from "@ai-sdk/harness";
import { logger } from "../logger.js";
import {
  withNativeRequestDecisions,
  type NativeRequestCall,
  type NativeRequestDecision,
} from "./auto-approve-harness.js";

/**
 * The narrowest mode that asks before a command. Claude Code asks then only
 * about `Bash` and `Monitor`, so its edits and MCP calls never leave the box;
 * Codex has no such mode and asks about every command and file change.
 */
export const COMMAND_GATE_PERMISSION_MODE: HarnessV1PermissionMode =
  "allow-edits";

/** Who can answer a request the gate leaves to a person. */
export type CommandGateAnswerer = "member" | "guest" | "nobody";

/**
 * Who answers on this turn. A guest is a User Testing participant, whatever
 * else holds. Nobody answers a run with no one watching (an eval, a swarm,
 * an API or event turn), or a turn that has no session to pause and resume.
 */
export function commandGateAnswerer(turn: {
  approvalMode?: string;
  sourceType?: string;
  scenarioParticipant?: boolean;
  resumable: boolean;
}): CommandGateAnswerer {
  if (turn.scenarioParticipant) return "guest";
  return turn.approvalMode === "auto-deny" ||
    turn.sourceType === "eval" ||
    turn.sourceType === "swarm" ||
    !turn.resumable
    ? "nobody"
    : "member";
}

export interface CommandGateState {
  /** A server's skill is in the turn's transcript. */
  inUse: boolean;
  /** The host's approval switch: on, every request asks a person. */
  switchOn: boolean;
  answerer: CommandGateAnswerer;
}

/**
 * Requests that run no code: file edits, the runtime's own planning and task
 * tools, and an MCP server's tool, which runs on that server. Any other
 * request counts as a command, so a tool the runtime adds later is gated
 * until it is listed here.
 */
const NOT_COMMANDS = new Set([
  // Codex reports a patch under this name, and its native `apply_patch`.
  "fileChange",
  "apply_patch",
  // Claude Code's edit tools, by their common and native names.
  "write",
  "edit",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "EnterWorktree",
  "ExitWorktree",
  "ExitPlanMode",
]);

const MCP_TOOL_PREFIX = "mcp__";

/** Whether a request asks to run code on the box. A request the runtime
 *  named no call for is one. */
export function isCommandRequest(call: NativeRequestCall | undefined): boolean {
  if (!call) return true;
  const names = [call.name, call.nativeName].filter(
    (name): name is string => typeof name === "string",
  );
  return !names.some(
    (name) => NOT_COMMANDS.has(name) || name.startsWith(MCP_TOOL_PREFIX),
  );
}

const APPROVE: NativeRequestDecision = { kind: "approve" };
const ASK: NativeRequestDecision = { kind: "ask" };

/** What the model reads when the gate refuses a command. */
export const COMMAND_REFUSED_IN_USE = {
  nobody:
    "MCPJam did not run this command: a skill from an MCP server is in use " +
    "in this conversation, and nobody can approve commands on this run. " +
    "Continue without running commands.",
  guest:
    "MCPJam did not run this command: a skill from an MCP server is in use " +
    "in this conversation, and commands can't be approved in a study " +
    "session. Continue without running commands.",
} as const;

const REFUSED_UNANSWERED =
  "MCPJam did not run this call: it needs approval, and nobody can " +
  "approve it on this run.";

/** MCPJam's answer to one request from a runtime the gate holds. */
export function commandGateDecision(
  call: NativeRequestCall | undefined,
  state: CommandGateState,
): NativeRequestDecision {
  if (state.inUse && isCommandRequest(call)) {
    return state.answerer === "member"
      ? ASK
      : { kind: "deny", reason: COMMAND_REFUSED_IN_USE[state.answerer] };
  }
  if (!state.switchOn) return APPROVE;
  // The turn's approval refusal keeps an unattended turn from getting here
  // with the switch on; a request nobody can answer must not wait for one.
  return state.answerer === "nobody"
    ? { kind: "deny", reason: REFUSED_UNANSWERED }
    : ASK;
}

/**
 * The gate's switch and who answers, for a turn with these handler options.
 * A local turn always asks, and MCPJam answers it only with the switch off; a
 * hosted turn asks only when the switch is on or the gate holds it.
 */
export function commandGateTurn(
  options: {
    requireToolApproval?: boolean;
    approvalMode?: string;
    sourceType?: string;
    scenarioParticipant?: boolean;
  },
  turn: { local: boolean; resumable: boolean },
): Omit<CommandGateState, "inUse"> {
  return {
    switchOn: turn.local
      ? options.requireToolApproval !== false
      : options.requireToolApproval === true,
    answerer: commandGateAnswerer({ ...options, resumable: turn.resumable }),
  };
}

/**
 * The runtime with MCPJam answering its requests through the gate. `inUse` is
 * read at each request, so a skill loaded earlier in the turn counts. A
 * request whose decision a continuation already carries is the person's.
 */
export function withServerSkillCommandGate<T extends HarnessV1>(
  harness: T,
  gate: Omit<CommandGateState, "inUse"> & {
    inUse: () => boolean;
    pendingApprovalIds: ReadonlySet<string>;
    /** Logged with each answer; ids only, never a command. */
    log?: Record<string, unknown>;
  },
): T {
  return withNativeRequestDecisions(
    harness,
    (call) =>
      commandGateDecision(call, {
        inUse: gate.inUse(),
        switchOn: gate.switchOn,
        answerer: gate.answerer,
      }),
    {
      pendingApprovalIds: gate.pendingApprovalIds,
      onAnswer: (approvalId, answer) =>
        logger.info("[harness] server-skill command gate answered", {
          ...gate.log,
          approvalId,
          approvalDecision: answer.kind,
        }),
    },
  );
}
