/**
 * Approvals a runtime asks for itself, bound to the one request each is for.
 *
 * Cursor raises its own permission prompt before it sends an MCP request, and
 * the user answers there. Recording the answer as a binding (server, tool,
 * argument digest, ACP call) before the runtime hears it lets the forwarder
 * run exactly one matching request without asking a second time. With no
 * match, or several, the forwarder's own gate asks.
 *
 * Cursor's ACP bridge numbers its prompts per process (`acp-permission-<n>`),
 * so an approval id comes back for a different call once the bridge restarts.
 * A decision therefore names its call too (the approval request the browser
 * showed), and only the paused call with that approval id and ACP tool-call id
 * takes it. Cursor mints a fresh `tool_<uuid>` per call, so the pair names one
 * call across bridge processes. What gets bound is read from the server's
 * saved continuation, never from the browser's copy of the call.
 */
import { createHash } from "node:crypto";
import type { HarnessV1 } from "@ai-sdk/harness";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { canonicalJson } from "../../tool-approval-token.js";
import { logger } from "../../logger.js";
import { coerceToolInput } from "../tool-input.js";
import { withTurnEmit } from "../turn-emit.js";
import {
  createExecutionControl,
  type ForwardingOwner,
} from "./execution-control.js";

/** The backend's digest of a forwarded `tools/call`'s arguments (absent is `{}`). */
export function approvalArgsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex");
}

/** A decision for a call or turn that is no longer waiting on it. */
export const APPROVAL_UNAVAILABLE =
  "The session for this approval is no longer available; the pending action will not run. Start a new turn.";

/** A decision with the call it was made for. */
export type DecidedCall = { approvalId: string; toolCallId: string };

/** A paused call a decision answers, as the server saved it. */
export type PausedApprovalCall = DecidedCall & {
  toolName: string;
  input: unknown;
  approved: boolean;
};

const pausedState = z.object({
  pendingToolApprovals: z.array(
    z.object({
      approvalId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      input: z.unknown(),
    }),
  ),
});

/** Each decision's approval id with the call the browser showed it for. */
export function decidedCalls(
  messages: ModelMessage[],
  continuations: ReadonlyArray<{ approvalId: string }>,
): DecidedCall[] {
  const asked = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const part of message.content)
      if (part.type === "tool-approval-request")
        asked.set(part.approvalId, part.toolCallId);
  }
  return continuations.map(({ approvalId }) => {
    const toolCallId = asked.get(approvalId);
    if (!toolCallId) throw new Error(APPROVAL_UNAVAILABLE);
    return { approvalId, toolCallId };
  });
}

/**
 * The paused calls these decisions answer, read from the turn's saved
 * continuation. A decision that names any other call (a stale tab's, after
 * the bridge renumbered its prompts) fails the turn: nothing is recorded and
 * the runtime never hears it.
 */
export function pausedCallsForDecisions(
  resumeState: unknown,
  decided: DecidedCall[],
  continuations: ReadonlyArray<{ approvalId: string; approved: boolean }>,
): PausedApprovalCall[] {
  const paused = pausedState.safeParse(resumeState);
  return decided.map((decision) => {
    const call = paused.success
      ? paused.data.pendingToolApprovals.find(
          (entry) =>
            entry.approvalId === decision.approvalId &&
            entry.toolCallId === decision.toolCallId,
        )
      : undefined;
    if (!call) throw new Error(APPROVAL_UNAVAILABLE);
    return {
      ...call,
      approved:
        continuations.find(({ approvalId }) => approvalId === call.approvalId)
          ?.approved === true,
    };
  });
}

/**
 * A decision answers only the call it was made for. A bridge that lost its
 * process reruns the turn and numbers its prompts from 1 again, so a new
 * prompt can arrive under a decided approval id, and the framework would
 * answer it with that decision. Such a prompt fails the turn instead.
 */
export function answerOnlyDecidedCalls<T extends HarnessV1>(
  harness: T,
  decided: DecidedCall[],
): T {
  return withTurnEmit(harness, (emit) => (part) => {
    const renumbered =
      part.type === "tool-approval-request" &&
      decided.some(
        (call) =>
          call.approvalId === part.approvalId &&
          call.toolCallId !== part.toolCallId,
      );
    if (renumbered) emit({ type: "error", error: new Error(APPROVAL_UNAVAILABLE) });
    else emit(part);
  });
}

export function createApprovalBindings(args: {
  owners: ForwardingOwner[];
  keyToServerId: Record<string, string>;
  attributeToolCall?: (call: {
    rawToolName: string;
    input: unknown;
    keyToServerId: Record<string, string>;
  }) => { serverId?: string; toolName: string };
  /** The turn this grant was installed for: bindings live on it. */
  grantTurnId: string;
}) {
  const bound = new Map<string, ForwardingOwner>();
  return {
    /** Bind each approved forwarded call, before the runtime hears the answer. */
    record: async (calls: PausedApprovalCall[]): Promise<void> => {
      const attribute = args.attributeToolCall;
      if (!attribute) return;
      for (const call of calls) {
        if (!call.approved) continue;
        const input = coerceToolInput(call.input);
        const { serverId, toolName } = attribute({
          rawToolName: call.toolName,
          input,
          keyToServerId: args.keyToServerId,
        });
        const owner = args.owners.find((entry) => entry.serverId === serverId);
        // Not a forwarded MCP call: the runtime's own approval is the whole story.
        if (!serverId || !owner) continue;
        const callArgs =
          input && typeof input === "object" ? Reflect.get(input, "args") : undefined;
        const result = await createExecutionControl({ owner }).recordApproval(
          args.grantTurnId,
          call.toolCallId,
          toolName,
          approvalArgsDigest(callArgs),
        );
        // A call or turn that already ended takes no decision.
        if (!result.recorded) throw new Error(APPROVAL_UNAVAILABLE);
        bound.set(call.toolCallId, owner);
      }
    },
    /** Void a bound call's binding once the runtime reports the call ended. */
    voidOnCallEnd: <T extends HarnessV1>(harness: T): T =>
      withTurnEmit(harness, (emit) => (part) => {
        emit(part);
        const owner =
          part.type === "tool-result" ? bound.get(part.toolCallId) : undefined;
        if (part.type !== "tool-result" || !owner) return;
        bound.delete(part.toolCallId);
        void createExecutionControl({ owner })
          .voidApprovals(args.grantTurnId, part.toolCallId)
          .catch((error: unknown) => {
            // The turn's end clears every binding of its grant anyway.
            logger.warn("[harness-forwarding] binding void left to turn end", {
              reason: error instanceof Error ? error.name : "unknown",
            });
          });
      }),
  };
}
