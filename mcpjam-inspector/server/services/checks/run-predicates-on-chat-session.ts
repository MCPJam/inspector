/**
 * Cross-surface checks orchestrator (Layer B).
 *
 * Runs the existing eval predicate library against a stored `chatSessions`
 * transcript on demand — the "second caller" of `evaluatePredicates` beyond
 * the live eval runner (see `server/services/evals-runner.ts:1543-1554` for
 * the in-eval invocation this mirrors). Same SDK gate, different transcript
 * source: instead of building the iteration transcript live from per-turn
 * runner state, we load the persisted envelope from Convex via
 * `chatSessionChecks/loadChatSessionEnvelopeAuthorized` and adapt it onto
 * the SDK's `IterationTranscript` shape.
 *
 * Lifecycle on the backend:
 *   1. `startCheckRun`    — persists a `chatSessionChecks` row with a
 *                           `definitionSnapshot` of `{setKind, setRef?,
 *                           setVersion?, predicates}` so the run is auditable
 *                           even if the source predicate set later mutates.
 *   2. `loadChatSessionEnvelopeAuthorized` — authorized read of the stored
 *                           transcript (`{traceVersion, messages, spans?,
 *                           prompts?, widgetSnapshots?}`).
 *   3. `completeCheckRun`  — persists `predicateResults`.
 *   4. `failCheckRun`      — persists the error message; called on any
 *                           orchestrator-level failure (auth, fetch,
 *                           predicate eval).
 *
 * Backend types/actions are referenced by string path; the Convex codegen
 * is on a sibling PR (`feat/chat-session-trace-loader`), so we cast the
 * string args via `as any` (mirrors the existing pattern at
 * `evals-runner.ts:699` for `testSuites:updateTestIteration`). Once the
 * backend PR merges and codegen runs, the string paths can be tightened
 * to typed `api.chatSessionChecks.*` references — no other shape change
 * required.
 */

import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import {
  buildIterationTranscript,
  evaluatePredicates,
} from "@/shared/eval-matching";
import type {
  Predicate,
  PredicateResult,
  TranscriptToolCall,
} from "@/shared/eval-matching";
import { extractToolCallsFromConversation } from "@/shared/eval-tool-call-projection";

// Re-declared narrowly here (not imported from generated Convex types) for the
// same reason as the action-name strings: the backend codegen isn't available
// in this worktree yet. Once the sibling backend PR merges, callers can use the
// generated `Id<"chatSessions">` / `Id<"chatSessionChecks">` directly.
export type ChatSessionId = string & { readonly __tableName: "chatSessions" };
export type CheckRunId = string & {
  readonly __tableName: "chatSessionChecks";
};
export type UserId = string & { readonly __tableName: "users" };

export type CheckSetKind = "suite_defaults" | "case_resolved" | "ad_hoc";

export interface RunPredicatesOnChatSessionArgs {
  /** Already-authenticated Convex HTTP client (caller called `setAuth`). */
  convexClient: ConvexHttpClient;
  /** Bearer token; unused on the Convex client path but threaded for future
   * HTTP-action calls in case the loader is reachable from both. Keeping the
   * arg in the signature avoids a breaking change later. */
  authHeader: string;
  chatSessionId: ChatSessionId;
  predicates: Predicate[];
  setKind: CheckSetKind;
  setRef?: string;
  setVersion?: number;
  triggeredBy?: UserId;
}

export interface RunPredicatesOnChatSessionResult {
  checkRunId: CheckRunId;
  results: PredicateResult[];
}

/**
 * Shape of the envelope returned by
 * `chatSessionChecks/loadChatSessionEnvelopeAuthorized`. Kept loose because
 * the backend codegen isn't present here; the consumer only depends on
 * `messages` (for tool-call extraction + final-message derivation) and
 * `spans` (for tool-error classification via `extractToolErrors`).
 */
export interface ChatSessionEnvelope {
  traceVersion?: number;
  messages: Array<{ role: string; content: unknown }>;
  spans?: Array<Record<string, unknown>>;
  prompts?: unknown[];
  widgetSnapshots?: unknown[];
}

/**
 * Walk messages and pull out tool calls in the order they appear.
 *
 * The walker itself is now `shared/eval-tool-call-projection.ts`, shared with
 * the eval runner. It used to be a copy of that logic with a NOTE calling
 * itself a mirror and a line-number back-reference that had since moved —
 * which is how a deliberate duplicate stops being one.
 *
 * Two shape differences are preserved here rather than in the shared module,
 * because they belong to THIS caller: there is never an AI SDK `steps` array
 * (the envelope is a persisted transcript, not a live run), and
 * `TranscriptToolCall` carries no `toolCallId`, so the id is dropped on the way
 * out. It still does its job inside the projection, where it distinguishes one
 * call seen twice from two calls that look alike.
 */
export function extractToolCallsFromEnvelopeMessages(
  messages: ChatSessionEnvelope["messages"],
): TranscriptToolCall[] {
  return extractToolCallsFromConversation({ messages }).map((toolCall) => ({
    toolName: toolCall.toolName,
    arguments: (toolCall.arguments ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Run a predicate set against a persisted chat session transcript.
 *
 * On any failure after `startCheckRun` succeeds, the row is finalized via
 * `failCheckRun` so the UI never sees an in-progress run stuck without
 * resolution. We rethrow after `failCheckRun` so the route can surface the
 * error to the caller with the right status code.
 */
export async function runPredicatesOnChatSession(
  args: RunPredicatesOnChatSessionArgs,
): Promise<RunPredicatesOnChatSessionResult> {
  const {
    convexClient,
    chatSessionId,
    predicates,
    setKind,
    setRef,
    setVersion,
    triggeredBy,
  } = args;

  // 1. Persist the run with a definition snapshot (audit anchor).
  const definitionSnapshot = {
    setKind,
    ...(setRef !== undefined ? { setRef } : {}),
    ...(setVersion !== undefined ? { setVersion } : {}),
    predicates,
  };
  const startResult = (await convexClient.mutation(
    "chatSessionChecks:startCheckRun" as any,
    {
      chatSessionId,
      // Deterministic predicate evaluation, never a judge — the per-session
      // Checks panel keys on this to decide which rows it owns.
      runKind: "checks",
      definitionSnapshot,
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
    },
  )) as { checkRunId: CheckRunId };
  const checkRunId = startResult.checkRunId;

  try {
    // 2. Load the persisted transcript envelope under the caller's auth.
    const envelope = (await convexClient.action(
      "chatSessionChecks:loadChatSessionEnvelopeAuthorized" as any,
      { chatSessionId },
    )) as ChatSessionEnvelope;

    // 3. Extract tool calls from messages — `toolCalls` is not a top-level
    //    envelope field today; eval derives it the same way per turn.
    const toolCalls = extractToolCallsFromEnvelopeMessages(envelope.messages);

    // 4. Build the SDK iteration transcript. Token usage IS materialized on
    //    the session row (`chatSessions.cumulativeInputTokens/OutputTokens`)
    //    but this loader doesn't return it yet, so leave undefined; token
    //    predicates against this transcript fail closed via the SDK's
    //    undefined-usage branch. The swarm path already threads it through
    //    the claim response — mirror that here when this path gets a caller.
    const transcript = buildIterationTranscript({
      trace: {
        messages: envelope.messages,
        ...(envelope.spans ? { spans: envelope.spans as any } : {}),
      },
      toolCalls,
      usage: undefined,
    });

    // 5. Pure SDK call — same function evals-runner.ts invokes.
    const results = evaluatePredicates(transcript, predicates);

    // 6. Persist the verdict.
    await convexClient.mutation(
      "chatSessionChecks:completeCheckRun" as any,
      {
        checkRunId,
        predicateResults: results,
      },
    );

    return { checkRunId, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await convexClient.mutation(
        "chatSessionChecks:failCheckRun" as any,
        { checkRunId, error: message },
      );
    } catch {
      // Swallow secondary failures — the primary error is what the caller
      // needs to see, and the row will eventually be reaped by backend
      // janitorial sweeps. Logging the secondary error here would mask the
      // real cause in route-level error envelopes.
    }
    throw error;
  }
}

// Re-export the `ModelMessage` type used to author tests for this module
// without forcing each consumer to import from `ai` directly. Kept narrowly
// scoped to the orchestrator boundary.
export type EnvelopeMessage = Pick<ModelMessage, "role" | "content"> & {
  toolCalls?: unknown;
};
