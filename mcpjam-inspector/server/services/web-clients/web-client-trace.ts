/**
 * The trace of a web client turn: the reply comes from the vendor's own saved
 * conversation, the tool calls from the wire (the forwarding endpoint's
 * ledger), joined as tightly as the vendor allows.
 *
 *  - `tool-use-id`: the conversation and the wire carry the same tool use id
 *    (claude.ai stamps `_meta["claudecode/toolUseId"]` on every call).
 *  - `time-only`: no id to join on (ChatGPT sends none), so the call is paired
 *    with the conversation's next unpaired call of the same tool, in order.
 *    The pairing is labeled so nobody reads it as a proven one.
 *  - `wire-only`: the server received a call the conversation never shows.
 *  - `narration-only`: the conversation shows a call no request carried.
 *
 * The ledger holds hashes, never arguments or results, so nothing here
 * carries a tool's payload except what the vendor's own conversation saved.
 */
import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LedgerEntry } from "./tool-call-ledger.js";
import type { HarnessPolicyBlockRecord } from "../../utils/harness/harness-proxy-policy-enforcement.js";
import type {
  ConversationToolCall,
  SavedConversation,
} from "../../utils/harness/real-ui/page-module.js";

export type WebToolCallMatch =
  | "tool-use-id"
  | "time-only"
  | "wire-only"
  | "narration-only";

export type WebToolCall = {
  toolName: string;
  match: WebToolCallMatch;
  toolUseId?: string;
  ledgerEntryId?: string;
  /** The id the run's tool policy refused a call under, when the vendor gave it none. */
  policyBlockId?: string;
  serverId?: string;
  state?: LedgerEntry["state"];
  forwardedAt?: string;
  settledAt?: string;
};

/** Joins the wire's calls to the conversation's, as described above. */
export function matchWebToolCalls(args: {
  wire: readonly LedgerEntry[];
  conversation: readonly ConversationToolCall[];
  serverOfConnector: (connectorId: string) => string | undefined;
  /** The calls the run's tool policy refused, which never reach the wire. */
  blocked?: readonly Pick<
    HarnessPolicyBlockRecord,
    "toolName" | "toolCallId"
  >[];
}): WebToolCall[] {
  const byTime = (a: { at?: string }, b: { at?: string }) =>
    (a.at ?? "").localeCompare(b.at ?? "");
  const narrated = [...args.conversation].sort(byTime);
  const paired = new Set<ConversationToolCall>();
  const calls: WebToolCall[] = [];
  const wire = [...args.wire].sort((a, b) => a.forwardedAt.localeCompare(b.forwardedAt));
  for (const entry of wire) {
    const byId = entry.toolUseId
      ? narrated.find((call) => !paired.has(call) && call.toolUseId === entry.toolUseId)
      : undefined;
    const byOrder = byId
      ? undefined
      : narrated.find(
          (call) => !paired.has(call) && !call.toolUseId && call.toolName === entry.toolName,
        );
    const partner = byId ?? byOrder;
    if (partner) paired.add(partner);
    calls.push({
      toolName: entry.toolName,
      match: byId ? "tool-use-id" : byOrder ? "time-only" : "wire-only",
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
      ledgerEntryId: entry.id,
      ...(args.serverOfConnector(entry.connectorId)
        ? { serverId: args.serverOfConnector(entry.connectorId) }
        : {}),
      state: entry.state,
      forwardedAt: entry.forwardedAt,
      ...(entry.settledAt ? { settledAt: entry.settledAt } : {}),
    });
  }
  // A refused call that carries no id (ChatGPT's) takes the one its refusal
  // was recorded under, by tool and in order, so the grade leaves it out by
  // that id as it does a refused call that carries the vendor's own.
  const refusedAs = new Map<ConversationToolCall, string>();
  for (const block of args.blocked ?? []) {
    if (
      !block.toolCallId ||
      narrated.some((call) => call.toolUseId === block.toolCallId)
    )
      continue;
    const partner = narrated.find(
      (call) =>
        !paired.has(call) &&
        !refusedAs.has(call) &&
        !call.toolUseId &&
        call.toolName === block.toolName,
    );
    if (partner) refusedAs.set(partner, block.toolCallId);
  }
  for (const call of narrated) {
    if (paired.has(call)) continue;
    const policyBlockId = refusedAs.get(call);
    calls.push({
      toolName: call.toolName,
      match: "narration-only",
      ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
      ...(policyBlockId ? { policyBlockId } : {}),
    });
  }
  return calls;
}

// A call with no id of its own is named within its turn: the transcript keeps
// every turn's calls, and two turns' first calls must not share a name.
const callId = (call: WebToolCall, index: number, turnId: string) =>
  call.toolUseId ??
  call.ledgerEntryId ??
  call.policyBlockId ??
  `web-call-${turnId}-${index}`;

/** The assistant's turn as the transcript stores it. */
export function webTurnMessages(
  conversation: SavedConversation,
  calls: readonly WebToolCall[],
  turnId: string,
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        ...calls.map((call, index) => ({
          type: "tool-call" as const,
          toolCallId: callId(call, index, turnId),
          toolName: call.toolName,
          input: {},
          // Where the call came from, kept beside it so a reader can tell a
          // call proven by id from one paired by time.
          providerOptions: {
            mcpjam: {
              webClientMatch: call.match,
              ...(call.ledgerEntryId ? { ledgerEntryId: call.ledgerEntryId } : {}),
            },
          },
        })),
        { type: "text" as const, text: conversation.replyText },
      ],
    },
  ];
}

/**
 * One step span for the turn and one tool span per call. A turn whose page
 * stopped (`failed`) keeps the calls that reached the server on an errored
 * step.
 */
export function webTurnSpans(args: {
  calls: readonly WebToolCall[];
  turnId: string;
  startedAt: number;
  endedAt: number;
  promptIndex: number;
  modelId: string;
  failed?: boolean;
}): EvalTraceSpan[] {
  const offset = (iso: string | undefined, fallback: number) =>
    iso ? Math.max(0, Date.parse(iso) - args.startedAt) : fallback;
  const total = args.endedAt - args.startedAt;
  // The turn's, not one call's: while any call is unsettled, a call the wire
  // never showed may simply not have been seen yet.
  const evidenceStatus = args.calls.some((call) => call.state === "forwarded")
    ? "incomplete"
    : "complete";
  const step: EvalTraceSpan = {
    id: "web-step-0",
    name: "Web client turn",
    category: "step",
    startMs: 0,
    endMs: total,
    promptIndex: args.promptIndex,
    stepIndex: 0,
    status: args.failed ? "error" : "ok",
    modelId: args.modelId,
  };
  return [
    step,
    ...args.calls.map((call, index): EvalTraceSpan => {
      const onWire = call.match !== "narration-only";
      const failed = call.state === "error" || call.state === "lost";
      const startMs = offset(call.forwardedAt, 0);
      return {
        id: `web-tool-${index}`,
        parentId: step.id,
        name: call.toolName,
        category: "tool",
        startMs,
        endMs: Math.max(startMs, offset(call.settledAt, total)),
        promptIndex: args.promptIndex,
        stepIndex: 0,
        status: failed ? "error" : "ok",
        toolCallId: callId(call, index, args.turnId),
        toolName: call.toolName,
        toolOrigin: "mcp",
        ...(call.serverId ? { serverId: call.serverId } : {}),
        outputSource: onWire ? (call.match === "wire-only" ? "reconstructed" : "evidence") : "narration",
        wireCorroborated: onWire,
        ...(call.ledgerEntryId ? { evidenceRequestId: call.ledgerEntryId } : {}),
        evidenceStatus,
      };
    }),
  ];
}
