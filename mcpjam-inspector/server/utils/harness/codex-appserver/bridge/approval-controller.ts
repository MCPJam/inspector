/**
 * Server requests from `codex app-server`: approvals, and the two prompts we
 * decline.
 *
 * ## The authority rule
 *
 * Exactly one party decides any given call, and which party depends on WHO RUNS
 * IT:
 *
 *  - Codex's own actions (a shell command, a patch) are Codex's to ask about.
 *    It raises a server request, this controller turns it into the harness
 *    pause, and the human's answer goes back as the decision.
 *  - MCPJam's host tools run on MCPJam's server. The framework gates them
 *    itself, before `execute`, via `HarnessAgent`'s `toolApproval` map. This
 *    controller must never prompt for one — a second prompt for the same call
 *    is not extra safety, it is a bug that makes a user approve twice and makes
 *    "did they approve?" unanswerable.
 *
 * Nothing here can prompt for a host tool by construction: host tools reach the
 * model through the relay MCP server, and codex 0.149.1 raises NO approval
 * request for an MCP tool call at all (verified against the generated schema
 * and a live run). The invariant is stated because it is load-bearing, not
 * because it is fragile.
 *
 * ## Ordering
 *
 * Codex sends the approval BEFORE `item/started`, so the tool call the harness
 * requires to already exist is seeded here through the translator's
 * `ensureToolCall`, and the later item is a no-op.
 *
 * ## Nothing may hang
 *
 * Codex blocks a turn on an unanswered server request. Every method reachable
 * here therefore has an answer, including the ones we do not implement: an
 * unanswered elicitation is a wedged sandbox that eventually TTLs out with no
 * explanation.
 */
import type { BridgeTurn } from "@ai-sdk/harness/bridge";
import {
  CODEX_APPSERVER_NATIVE_TOOL_NAMES,
  CODEX_APPSERVER_TOOL_NAMES,
} from "../shared/tool-names.js";
import type {
  ApprovalDecision,
  CommandExecutionApprovalParams,
  FileChangeApprovalParams,
  JsonRpcRequest,
  PermissionsApprovalParams,
  ToolRequestUserInputParams,
} from "./app-server-protocol.js";
import type { Translator } from "./stream-translator.js";

export type ApprovalController = {
  handle(request: JsonRpcRequest): Promise<unknown>;
  /** Reject every awaiting approval (abort / replacement turn). */
  cancelAll(): void;
};

export function createApprovalController(input: {
  turn: BridgeTurn;
  translator: Translator;
  /** Called when a decision cannot be obtained and the turn should stop. */
  onInterrupt?(): void;
}): ApprovalController {
  const { turn, translator } = input;
  let approvalSeq = 0;
  let cancelled = false;
  const waiting = new Set<(decision: ApprovalDecision) => void>();

  /**
   * Emit the pause and wait for the host's answer.
   *
   * The approval id is MINTED HERE rather than taken from Codex's optional
   * `approvalId`: it is nullable on the wire, and the harness requires a stable
   * non-empty id to correlate the response. Codex correlates by JSON-RPC id
   * anyway, so ours never has to match theirs.
   */
  const pause = async (toolCallId: string): Promise<ApprovalDecision> => {
    if (cancelled) return "cancel";
    const approvalId = `codex-approval-${++approvalSeq}`;
    turn.emit({ type: "tool-approval-request", approvalId, toolCallId });

    let settle: ((decision: ApprovalDecision) => void) | undefined;
    const cancellation = new Promise<ApprovalDecision>((resolve) => {
      settle = resolve;
      waiting.add(resolve);
    });
    try {
      const decision = await Promise.race([
        turn
          .requestToolApproval(approvalId)
          .then(({ approved }): ApprovalDecision =>
            // `decline` and not `cancel`: cancel reads to Codex as "the user
            // walked away", decline as "the user said no". Verified live that
            // decline is honoured even when `availableDecisions` omits it, and
            // it produces the `declined` item status the trace should show.
            approved ? "accept" : "decline",
          ),
        cancellation,
      ]);
      return decision;
    } catch (error) {
      // A rejected approval promise means the host went away mid-decision.
      // Cancelling is the only answer that does not run unapproved work.
      turn.bridgeLog({
        level: "warn",
        subsystem: "approval",
        message: "approval request failed; cancelling",
        error,
      });
      return "cancel";
    } finally {
      if (settle) waiting.delete(settle);
    }
  };

  const handleCommandExecution = async (
    params: CommandExecutionApprovalParams,
  ) => {
    const toolCallId = translator.ensureToolCall(params.itemId, {
      toolName: CODEX_APPSERVER_TOOL_NAMES.commandExecution,
      nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.commandExecution,
      input: {
        command: params.command ?? "",
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.commandActions?.length
          ? { commandActions: params.commandActions }
          : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });
    return { decision: await pause(toolCallId) };
  };

  const handleFileChange = async (params: FileChangeApprovalParams) => {
    // The approval carries no `changes` — those arrive on the item. The call is
    // seeded with what IS known so the pause can happen at all; the completed
    // item's tool-result carries the paths.
    const toolCallId = translator.ensureToolCall(params.itemId, {
      toolName: CODEX_APPSERVER_TOOL_NAMES.fileChange,
      nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.fileChange,
      input: {
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
      },
    });
    return { decision: await pause(toolCallId) };
  };

  const handlePermissions = async (params: PermissionsApprovalParams) => {
    // Only reachable under `approvalPolicy: {granular: {request_permissions}}`,
    // which this adapter never sets. Granting nothing is the safe answer, and
    // the warning is how it becomes visible if the policy ever changes.
    turn.emitWarning({
      message:
        "Codex asked to widen its permissions mid-turn; MCPJam granted none " +
        `(cwd: ${params.cwd}).`,
    });
    return { permissions: [], scope: "turn" };
  };

  const handleUserInput = async (params: ToolRequestUserInputParams) => {
    // `request_user_input` is a plan-mode tool. MCPJam's turn has no channel to
    // put a mid-turn questionnaire in front of the user, so it is answered
    // empty rather than left to block.
    turn.emitWarning({
      message:
        "Codex asked the user a question mid-turn " +
        `(${params.questions.map((q) => q.question).join(" / ")}); ` +
        "MCPJam answered with no input.",
    });
    return { answers: {} };
  };

  const handleElicitation = async () => {
    turn.emitWarning({
      message:
        "An MCP server asked for interactive input; MCPJam declined it. " +
        "Configure the server's credentials on the host instead.",
    });
    return { action: "decline", content: null };
  };

  return {
    async handle(request) {
      const params = (request.params ?? {}) as Record<string, unknown>;
      switch (request.method) {
        case "item/commandExecution/requestApproval":
          return handleCommandExecution(
            params as unknown as CommandExecutionApprovalParams,
          );
        case "item/fileChange/requestApproval":
          return handleFileChange(
            params as unknown as FileChangeApprovalParams,
          );
        case "item/permissions/requestApproval":
          return handlePermissions(
            params as unknown as PermissionsApprovalParams,
          );
        case "item/tool/requestUserInput":
          return handleUserInput(
            params as unknown as ToolRequestUserInputParams,
          );
        case "mcpServer/elicitation/request":
          return handleElicitation();
        default:
          // A JSON-RPC "method not found" is an ANSWER. Codex treats it as a
          // failure of that request and moves on, where silence would wedge it.
          throw new Error(`unsupported server request: ${request.method}`);
      }
    },
    cancelAll() {
      cancelled = true;
      for (const resolve of waiting) resolve("cancel");
      waiting.clear();
      input.onInterrupt?.();
    },
  };
}
