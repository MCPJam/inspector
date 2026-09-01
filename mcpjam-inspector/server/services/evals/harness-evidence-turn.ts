/**
 * One turn's evidence pass: read once, reconcile, annotate, project.
 *
 * The driver calls this at exactly one point — after the harness turn returns
 * and BEFORE its spans drain into the iteration accumulator — because the
 * spans this annotates are the ones about to be persisted. Annotating a copy
 * the accumulator already holds would leave the stored trace unprovenanced
 * while the in-memory one looked correct, which is the kind of bug that only
 * shows up when somebody opens a run detail page a week later.
 *
 * ONE SNAPSHOT, ONE VERDICT. The read happens once and every consumer here —
 * completeness, span provenance, the trace transcript — uses that same row
 * set. A second read could see a laggard settlement land in between and have
 * two parts of the same turn disagree about whether it was complete.
 *
 * Inert unless the run FROZE capture on. Everything below no-ops for the
 * emulated engine, for playground traffic, for a quick run with no iteration,
 * and for any harness run whose org never enabled capture — which is what
 * makes a capture-off run byte-identical to one from before evidence existed.
 */
import type { ModelMessage } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { extractToolCallsFromConversation } from "@/shared/eval-tool-call-projection";
import { logger } from "../../utils/logger.js";
import {
  createConvexEvidenceReadTransport,
  readTurnEvidence,
  type EvidenceReadTransport,
} from "../../utils/harness/harness-evidence-reader.js";
import {
  buildEvidenceToolResultMessage,
  mergeHarnessEvidence,
  type EvidenceCompleteness,
  type MergeResult,
  type NarratedToolCall,
} from "./harness-evidence-merge.js";
import { annotateSpansWithEvidence } from "./harness-evidence-spans.js";

/**
 * The marker the proxy returns for a call it refused because the call's start
 * could not be recorded. A refused call leaves NO evidence row, so the
 * narration is the only place it exists — see `assessCompleteness`.
 */
const EVIDENCE_UNAVAILABLE_MARKER = "could not record this tool call";

export type TurnEvidenceResult = {
  /** Spans to persist — provenance-annotated when capture ran. */
  spans: EvalTraceSpan[];
  /**
   * Evidence-enriched messages for the TRACE transcript, or `undefined` when
   * capture did not run.
   *
   * Never the model's transcript. The harness conversation continues from what
   * it actually narrated, and a message here that the harness never produced
   * would put words in the model's history that it never saw.
   */
  traceMessages?: ModelMessage[];
  completeness?: EvidenceCompleteness;
  merge?: MergeResult;
};

export type ReconcileTurnEvidenceArgs = {
  iterationId?: string;
  turnId?: string;
  captureEnabled: boolean;
  spans: EvalTraceSpan[];
  /** The messages this turn added — the narration to reconcile against. */
  newMessages: ModelMessage[];
  /** `toolCallId`s a tool policy refused; they never reached a server. */
  policyBlockedToolCallIds?: ReadonlySet<string>;
  /** Injectable for tests; production reads through the service token. */
  transport?: EvidenceReadTransport;
};

/**
 * Pull the narrated MCP calls out of a turn's new messages.
 *
 * Arguments come from the messages (spans do not carry them) and `serverId`
 * from the spans (the projection does not resolve it), so the two are joined
 * on `toolCallId` — which both sides mint from the same harness event.
 */
export function collectNarratedCalls(args: {
  newMessages: ModelMessage[];
  spans: readonly EvalTraceSpan[];
  policyBlockedToolCallIds?: ReadonlySet<string>;
}): NarratedToolCall[] {
  const serverIdByToolCallId = new Map<string, string>();
  for (const span of args.spans) {
    if (span.category === "tool" && span.toolCallId && span.serverId) {
      serverIdByToolCallId.set(span.toolCallId, span.serverId);
    }
  }

  return extractToolCallsFromConversation({
    messages: args.newMessages,
  }).flatMap((call) => {
    if (!call.toolCallId) return [];
    const serverId = serverIdByToolCallId.get(call.toolCallId);
    return [
      {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(serverId ? { serverId } : {}),
        arguments: call.arguments,
        ...(args.policyBlockedToolCallIds?.has(call.toolCallId)
          ? { policyBlocked: true as const }
          : {}),
      },
    ];
  });
}

/**
 * Did the harness narrate a refusal from the evidence layer?
 *
 * Read out of the narration because that is the only record of it: the proxy
 * refuses BEFORE writing a row, so a refused call is invisible to the row set.
 * Matched on the message text for the same reason the policy-block reader is —
 * the harness flattens tool results to strings, so a structural marker would
 * not survive the trip.
 */
export function sawEvidenceUnavailableMarker(
  messages: readonly ModelMessage[],
): boolean {
  for (const message of messages) {
    if (!message || (message as { role?: string }).role !== "tool") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const serialized = JSON.stringify(
        (part as { output?: unknown }).output ?? "",
      );
      if (serialized.includes(EVIDENCE_UNAVAILABLE_MARKER)) return true;
    }
  }
  return false;
}

/**
 * Project the trace transcript: the narration, plus a tool-result message for
 * every wire call it never mentioned.
 *
 * Matched calls are left as narrated — their raw result rides the evidence row
 * that the span now points at, and rewriting the narrated part would change
 * what the transcript says the model saw.
 */
function buildTraceMessages(
  newMessages: ModelMessage[],
  merge: MergeResult,
): ModelMessage[] {
  if (merge.wireOnlyCalls.length === 0) return newMessages;
  return [
    ...newMessages,
    ...merge.wireOnlyCalls.map(
      (call) => buildEvidenceToolResultMessage(call) as unknown as ModelMessage,
    ),
  ];
}

export async function reconcileTurnEvidence(
  args: ReconcileTurnEvidenceArgs,
): Promise<TurnEvidenceResult> {
  if (!args.captureEnabled || !args.iterationId || !args.turnId) {
    return { spans: [...args.spans] };
  }

  const read = await readTurnEvidence({
    iterationId: args.iterationId,
    turnId: args.turnId,
    transport: args.transport ?? createConvexEvidenceReadTransport(),
  });

  const narratedCalls = collectNarratedCalls({
    newMessages: args.newMessages,
    spans: args.spans,
    ...(args.policyBlockedToolCallIds
      ? { policyBlockedToolCallIds: args.policyBlockedToolCallIds }
      : {}),
  });

  const merge = mergeHarnessEvidence({
    rows: read.rows,
    readExhausted: read.exhausted,
    narratedCalls,
    sawEvidenceUnavailableMarker: sawEvidenceUnavailableMarker(
      args.newMessages,
    ),
  });

  if (merge.completeness.status === "incomplete") {
    // Worth a line: this is the run degrading to narration grading, and the
    // reason distinguishes a lost settlement from capture that never armed.
    logger.warn("[harness-evidence] turn evidence is incomplete", {
      iterationId: args.iterationId,
      turnId: args.turnId,
      reason: merge.completeness.reason,
      rows: read.rows.length,
      narratedCalls: narratedCalls.length,
    });
  }

  return {
    spans: annotateSpansWithEvidence(args.spans, merge),
    // An incomplete turn gets NO synthetic messages. Its record is known to
    // have a hole, and adding reconstructed calls to a transcript that is
    // missing others would produce a transcript that is wrong in a new way
    // rather than one that is honestly partial.
    traceMessages:
      merge.completeness.status === "complete"
        ? buildTraceMessages(args.newMessages, merge)
        : args.newMessages,
    completeness: merge.completeness,
    merge,
  };
}
