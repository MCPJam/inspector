/**
 * Deterministic rubric grading for one swarm (journey) session.
 *
 * Why this lives inspector-side: Convex functions cannot import `@mcpjam/sdk`
 * (the bundling isolation that also forces `convex/lib/predicates.ts` to
 * hand-mirror the SDK's predicate union). The backend owns persistence and the
 * generation guard; the evaluation itself has to run where the evaluator does.
 *
 * The shape of the flow is load-bearing:
 *
 *   1. CLAIM — durable `pending` state, plus the transcript envelope, in one
 *      authorized round trip. Claiming FIRST is what makes a runner crash
 *      mid-grade survivable: the session reads "pending" (visible, re-runnable)
 *      instead of carrying no stamp, which downstream reads as "this run had
 *      no rubric" and would silently shrink every denominator.
 *   2. EVALUATE — the same `evaluatePredicates` the eval runner calls, over a
 *      transcript built the same way `run-predicates-on-chat-session.ts`
 *      builds one.
 *   3. COMPLETE or FAIL — verdicts correlated back to `criterionId`
 *      positionally, which is sound here and only here: `entries.map(…)` and
 *      the result array come from a single call with order preserved by
 *      contract. Nothing else in the system correlates by position.
 *
 * The caller (`swarm-runner.ts`) awaits this inside a try/catch. Grading is
 * never allowed to affect the attempt it graded.
 */

import {
  buildIterationTranscript,
  evaluatePredicates,
} from "@/shared/eval-matching";
import type { TranscriptToolCall } from "@/shared/eval-matching";
import {
  claimSwarmChecks,
  completeSwarmChecks,
  failSwarmChecks,
  type SwarmCriterionResult,
} from "../swarm-agent.js";

export interface RunSwarmChecksArgs {
  convexHttpUrl: string;
  bearer: string;
  projectId: string;
  runId: string;
  /** The attempt's EXTERNAL session id; the backend resolves it within the run. */
  chatSessionId: string;
  signal?: AbortSignal;
}

export type RunSwarmChecksOutcome =
  | { status: "skipped"; reason: "no_rubric" }
  | { status: "completed"; results: SwarmCriterionResult[] }
  | { status: "failed"; error: string };

/**
 * A message as it comes off the persisted envelope. `role` is `string` (not a
 * narrowed union) because the envelope is data we read back, not data we
 * construct — an unrecognized role must flow through and be ignored, not
 * fail the type.
 */
type EnvelopeMessage = { role: string; content: unknown; toolCalls?: unknown };

/**
 * Pull tool calls out of the persisted envelope in the order they appear.
 *
 * Mirrors `extractToolCallsFromEnvelopeMessages` in
 * `run-predicates-on-chat-session.ts`, INCLUDING its identity-based dedupe
 * (same tool + same args collapses to one entry). That dedupe is a known
 * limitation inherited from the eval path: a session that legitimately called
 * one tool twice with identical arguments reads as one call, so
 * `toolCalledWith` with `minCount > 1` can under-count. Reproducing the
 * behavior is deliberate — the two surfaces must agree on what a transcript
 * says, and fixing it in one place only would make the same session grade
 * differently depending on who asked.
 */
function extractToolCalls(messages: EnvelopeMessage[]): TranscriptToolCall[] {
  const toolsCalled: TranscriptToolCall[] = [];

  const push = (name: string, argumentsValue: Record<string, unknown>) => {
    const argsKey = JSON.stringify(argumentsValue);
    const alreadyAdded = toolsCalled.some(
      (call) =>
        call.toolName === name && JSON.stringify(call.arguments) === argsKey,
    );
    if (!alreadyAdded) toolsCalled.push({ toolName: name, arguments: argumentsValue });
  };

  for (const msg of messages) {
    if (!msg || msg.role !== "assistant") continue;

    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (
          !item ||
          typeof item !== "object" ||
          (item as { type?: unknown }).type !== "tool-call"
        ) {
          continue;
        }
        const rec = item as Record<string, unknown>;
        const name = (rec.toolName ?? rec.name) as string | undefined;
        if (!name) continue;
        push(
          name,
          (rec.input as Record<string, unknown> | undefined) ??
            (rec.parameters as Record<string, unknown> | undefined) ??
            (rec.args as Record<string, unknown> | undefined) ??
            {},
        );
      }
    }

    if (Array.isArray(msg.toolCalls)) {
      for (const call of msg.toolCalls) {
        if (!call || typeof call !== "object") continue;
        const rec = call as Record<string, unknown>;
        const name = (rec.toolName ?? rec.name) as string | undefined;
        if (!name) continue;
        push(
          name,
          (rec.args as Record<string, unknown> | undefined) ??
            (rec.input as Record<string, unknown> | undefined) ??
            {},
        );
      }
    }
  }

  return toolsCalled;
}

/** User-role messages — the unit `turnCountUnder` grades against. */
function countUserTurns(messages: EnvelopeMessage[]): number {
  return messages.filter((msg) => msg?.role === "user").length;
}

/**
 * Grade one session against its run's pinned rubric.
 *
 * Returns an outcome rather than throwing for the expected cases (no rubric,
 * grading failed) so the caller's log line can say what happened. Throws only
 * when the CLAIM itself fails — at that point nothing was stamped, so there is
 * no half-state to report.
 */
export async function runSwarmChecks(
  args: RunSwarmChecksArgs,
): Promise<RunSwarmChecksOutcome> {
  const { convexHttpUrl, bearer, projectId, runId, chatSessionId, signal } =
    args;

  const claim = await claimSwarmChecks(
    convexHttpUrl,
    bearer,
    { projectId, runId, chatSessionId },
    signal,
  );
  // No rubric pinned on the run. Nothing was stamped, and nothing should be:
  // absence of the stamp is the signal that keeps criterion denominators
  // honest.
  if (claim === null) return { status: "skipped", reason: "no_rubric" };

  const reportFailure = async (error: string): Promise<RunSwarmChecksOutcome> => {
    try {
      await failSwarmChecks(
        convexHttpUrl,
        bearer,
        {
          projectId,
          runId,
          sessionDocId: claim.sessionDocId,
          checkDocId: claim.checkDocId,
          generation: claim.generation,
          error,
        },
        signal,
      );
    } catch {
      // The `pending` stamp already left by the claim is the honest fallback
      // here, and it is re-runnable. Masking the real failure with a secondary
      // transport error would help nobody.
    }
    return { status: "failed", error };
  };

  const messages = Array.isArray(claim.envelope?.messages)
    ? (claim.envelope.messages as EnvelopeMessage[])
    : null;
  if (messages === null) {
    return reportFailure("transcript envelope unreadable");
  }

  let criterionResults: SwarmCriterionResult[];
  try {
    const transcript = buildIterationTranscript({
      trace: {
        messages,
        ...(claim.envelope?.spans
          ? { spans: claim.envelope.spans as never[] }
          : {}),
      },
      toolCalls: extractToolCalls(messages),
      // Swarm sessions carry no per-iteration token accounting on the
      // persisted envelope, so `tokenBudgetUnder` fails closed here by design.
      usage: undefined,
      turnCount: countUserTurns(messages),
    });

    const results = evaluatePredicates(
      transcript,
      claim.criteria.map((entry) => entry.predicate),
    );
    // Positional correlation — sound because both arrays come from the same
    // `claim.criteria` in the same call, and `evaluatePredicates` preserves
    // order by contract. Everything downstream is keyed by `criterionId`.
    criterionResults = claim.criteria.map((entry, index) => ({
      criterionId: entry.id,
      passed: results[index]?.passed ?? false,
      reason: results[index]?.reason ?? "evaluator returned no verdict",
    }));
  } catch (error) {
    return reportFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  await completeSwarmChecks(
    convexHttpUrl,
    bearer,
    {
      projectId,
      runId,
      sessionDocId: claim.sessionDocId,
      checkDocId: claim.checkDocId,
      generation: claim.generation,
      criterionResults,
    },
    signal,
  );
  return { status: "completed", results: criterionResults };
}
