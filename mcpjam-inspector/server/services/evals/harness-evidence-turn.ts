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
import {
  extractToolCallsFromConversation,
  type ProjectedToolCall,
} from "@/shared/eval-tool-call-projection";
import { logger } from "../../utils/logger.js";
import {
  EVIDENCE_UNAVAILABLE_CODE,
  EVIDENCE_UNAVAILABLE_MESSAGE,
} from "../mcp-http-bridge.js";
import {
  createConvexEvidenceReadTransport,
  readTurnEvidence,
  type EvidenceReadTransport,
} from "../../utils/harness/harness-evidence-reader.js";
import {
  buildEvidenceToolResultMessage,
  evidenceToolCallId,
  mergeHarnessEvidence,
  type EvidenceCompleteness,
  type MergeResult,
  type NarratedToolCall,
} from "./harness-evidence-merge.js";
import { annotateSpansWithEvidence } from "./harness-evidence-spans.js";

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
    // MCP-vs-native classification normally rides the span join above — and
    // span loss is a real path (a scope step-up breaks the harness stream
    // before the span push). A narrated name that is still MCP-SHAPED with no
    // span must not silently reclassify as native: it stays unmatched (there
    // is no serverId identity to match strictly on) but is flagged so the
    // completeness zero-row guard still counts it as an MCP call, and the
    // loss is a log line instead of a silent false green.
    const mcpShaped = !serverId && /^mcp__/u.test(call.toolName);
    if (mcpShaped) {
      logger.warn(
        "[harness-evidence] narrated MCP-shaped call has no span serverId",
        { toolCallId: call.toolCallId, toolName: call.toolName },
      );
    }
    return [
      {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(serverId ? { serverId } : {}),
        ...(mcpShaped ? { mcpShaped: true as const } : {}),
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
 *
 * Two guards keep prose-matching honest:
 *
 *  - The needle is the SHARED `EVIDENCE_UNAVAILABLE_MESSAGE` constant — the
 *    same value every producer returns — so rewording the model-facing copy
 *    moves producer and detector together instead of silently killing
 *    detection with every test still green.
 *  - Only an ERROR-shaped part (or one carrying the refusal's -32001 code)
 *    counts. A successful tool result QUOTING the refusal — a `Read` of a log
 *    that contains one — must not mark a fully-settled turn incomplete.
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
      const output = (part as { output?: unknown }).output;
      const serialized = JSON.stringify(output ?? "");
      if (!serialized.includes(EVIDENCE_UNAVAILABLE_MESSAGE)) continue;
      const outputType =
        output && typeof output === "object"
          ? (output as { type?: unknown }).type
          : undefined;
      const errorShaped =
        typeof outputType === "string" && outputType.startsWith("error");
      if (
        errorShaped ||
        serialized.includes(String(EVIDENCE_UNAVAILABLE_CODE))
      ) {
        return true;
      }
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

/**
 * The turn's graded tool-call set, from the SELECTED grading source.
 *
 * This is where the program's verdict semantics actually change hands, so the
 * rules are exactly the documented flip classes and nothing else:
 *
 *  - A MATCHED call keeps its narrated position and `toolCallId` but carries
 *    the SERVER-RECEIVED arguments — assertions grade what the server got,
 *    not what the harness said it sent.
 *  - A NARRATION-ONLY MCP call (narrated, no wire row, on a complete record)
 *    stops counting: the server never saw it.
 *  - A WIRE-ONLY call (executed, never narrated — the program's motivating
 *    case) is appended in wire order under its `evidence:<requestId>` id, so
 *    a dropped-but-executed call can satisfy an expectation.
 *  - NATIVE harness tools (Bash, Read — no proxy seam) pass through as
 *    narrated: evidence says nothing about them either way.
 *
 * Falls back to narration whenever it must: grading source is not
 * `'evidence'`, capture never ran, or the turn's evidence is incomplete. The
 * fallback is PER TURN — that is the completeness protocol's whole point.
 */
export function selectGradedToolCalls(args: {
  narration: ProjectedToolCall[];
  evidence: TurnEvidenceResult;
  gradingSource: "narration" | "evidence" | undefined;
}): ProjectedToolCall[] {
  const merge = args.evidence.merge;
  if (
    args.gradingSource !== "evidence" ||
    !merge ||
    merge.completeness.status !== "complete"
  ) {
    return args.narration;
  }

  const graded: ProjectedToolCall[] = [];
  for (const call of args.narration) {
    const matched = call.toolCallId
      ? merge.matchedByToolCallId.get(call.toolCallId)
      : undefined;
    if (matched) {
      graded.push({
        toolName: call.toolName,
        arguments: matched.arguments,
        ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
      });
      continue;
    }
    if (
      call.toolCallId &&
      merge.narrationOnlyToolCallIds.has(call.toolCallId)
    ) {
      continue;
    }
    graded.push(call);
  }
  for (const call of merge.wireOnlyCalls) {
    graded.push({
      toolName: call.toolName,
      arguments: call.arguments,
      toolCallId: evidenceToolCallId(call.requestId),
    });
  }
  return graded;
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
    unparseableRows: read.unparseableRows,
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
