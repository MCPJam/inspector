/**
 * Stamping evidence provenance onto a turn's tool spans.
 *
 * The spans are already built — by the harness turn, from what it narrated —
 * and this annotates them in place with what the reconciliation learned. It
 * deliberately does not BUILD spans from evidence: a span carries timing,
 * step indices and message ranges that only the turn loop knows, and a second
 * builder would drift from the first in exactly the places a reader compares
 * them.
 *
 * What each field claims, and why a reader needs it:
 *
 *   `outputSource` — where the recorded output came from. Without it a trace
 *   viewer cannot tell a result the model reported from one the proxy saw.
 *   `wireCorroborated` — on a COMPLETE turn, `false` means the model narrated
 *   a call the proxy never saw. On an incomplete one it would mean "we could
 *   not look", so it is left absent there rather than stated as a fact.
 *   `evidenceRequestId` — the join back to the row, so a reader can go from a
 *   span to the raw arguments and result.
 *   `evidenceStatus` — the turn's own completeness, carried per span because
 *   that is where a reader of one span needs it.
 */
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { MergeResult } from "./harness-evidence-merge";
import { evidenceToolCallId } from "./harness-evidence-merge";

/**
 * Annotate a turn's spans with the merge's findings.
 *
 * Returns a new array; the input spans are not mutated, because they are also
 * held by the accumulator the caller pushes into and a mutation would edit
 * history that has already been read.
 */
export function annotateSpansWithEvidence(
  spans: readonly EvalTraceSpan[],
  merge: MergeResult,
): EvalTraceSpan[] {
  const complete = merge.completeness.status === "complete";
  const evidenceStatus = complete ? "complete" : "incomplete";

  return spans.map((span) => {
    if (span.category !== "tool" || !span.toolCallId) {
      // Only tool spans make claims about MCP traffic. Stamping an llm or step
      // span would say something about a call it does not describe.
      return span;
    }

    const matched = merge.matchedByToolCallId.get(span.toolCallId);
    if (matched) {
      return {
        ...span,
        // The output the model saw is still the narrated one; what the wire
        // adds is corroboration and the raw result behind it.
        outputSource: "narration",
        wireCorroborated: true,
        evidenceRequestId: matched.requestId,
        evidenceStatus,
      };
    }

    if (span.toolCallId.startsWith("evidence:")) {
      // A span built for a wire-only call: its output was reconstructed from
      // the raw result, because there was no narration to take one from.
      const requestId = span.toolCallId.slice("evidence:".length);
      return {
        ...span,
        outputSource: "reconstructed",
        wireCorroborated: true,
        evidenceRequestId: requestId,
        evidenceStatus,
      };
    }

    if (merge.narrationOnlyToolCallIds.has(span.toolCallId)) {
      return {
        ...span,
        outputSource: "narration",
        // Only on a complete turn is this a claim about the world. On an
        // incomplete one the honest answer is that nobody could say, and
        // absent is how that is said.
        ...(complete ? { wireCorroborated: false } : {}),
        evidenceStatus,
      };
    }

    // A native harness tool (Bash, Read) or a policy-blocked call: never
    // crossed the proxy, so corroboration is not a meaningful question. The
    // turn's status still rides along, because a reader comparing spans within
    // one turn needs to know which turn they came from.
    return { ...span, evidenceStatus };
  });
}

/** The span ids a wire-only call's projected messages will use. */
export function wireOnlyToolCallIds(merge: MergeResult): string[] {
  return merge.wireOnlyCalls.map((call) => evidenceToolCallId(call.requestId));
}
