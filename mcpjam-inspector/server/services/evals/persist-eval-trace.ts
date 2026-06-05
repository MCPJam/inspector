import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type {
  EvalTraceSpan,
  EvalTraceWidgetSnapshot,
  PromptTraceSummary,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";

/**
 * Inspector-side per-turn fanout for the eval→chatSessions unification.
 *
 * Both `recorder.finishIteration` (multi-iteration suite runs) and
 * `finishIterationDirectly` (quick runs without a recorder) receive the
 * final accumulated transcript at end-of-iteration. When the backend
 * flag `USE_EVAL_CHAT_SESSIONS_WRITER` is on, we want N
 * `chatSessionTurnTraces` rows for an N-turn iteration so downstream
 * readers (eval-diff, judge, server-quality, the unified Sessions
 * viewer) can address each turn individually. This helper slices the
 * trace by `promptIndex` and calls `api.testSuites.appendEvalTurnTrace`
 * per turn. **No `terminal` is set on the per-turn calls** — callers
 * fire `lockEvalSessionAfterUpdate` AFTER `updateTestIteration`
 * succeeds so a downstream iteration-row failure cannot leave a
 * locked transcript without a finalized iteration (PR-2 review fix #2).
 *
 * Cadence-wise this is "per-turn data, single-call timing" — the
 * network round-trips happen at finishIteration time, not during the
 * iteration loop. Live observability of running evals (which would
 * require the runner's multi-turn loop itself to call this helper per
 * turn) is deferred to a follow-up. The data shape and reader fidelity
 * are identical between the two cadences.
 *
 * Return values:
 *   - `null`: flag is off; caller should run today's legacy path
 *     (single `updateTestIteration` call with full trace fields).
 *   - `{ persisted: true }`: trace was written via chatSessions;
 *     caller should call `updateTestIteration` with status/result
 *     and metadata ONLY — no `messages` / `spans` / `prompts` /
 *     `widgetSnapshots`. Passing trace fields after a successful
 *     fanout would re-fire `persistEvalTraceAction` on
 *     `updateTestIteration`'s W1 path and either be a silent no-op
 *     against the now-locked session or, worse, EVAL_SESSION_LOCKED
 *     if any turn index doesn't match.
 *   - `{ persisted: false, error }`: the per-turn fanout failed mid-
 *     stream. Caller should fall back to a forced-legacy-blob call by
 *     passing `forceLegacyTraceBlob: true` to `updateTestIteration`,
 *     which bypasses the backend's W1 chatSessions path even when the
 *     flag is on. Without that escape hatch the legacy fallback would
 *     re-enter the chatSessions writer with `promptIndex: 0` + full
 *     transcript, overwriting any partially-fanned-out turn rows.
 *
 * Flag-cache caveat: the cached `enabled` value is process-latched.
 * If the inspector starts before the backend deploys the
 * `isEvalChatSessionsWriterEnabled` action it caches `false`
 * permanently; a subsequent flag flip on the backend will not take
 * effect until the inspector process restarts. Same for the opposite
 * direction (cached `true` won't downgrade if the backend flips off).
 * Acceptable trade-off for a process-scoped feature flag; document
 * this in the deploy runbook before flipping the flag in prod.
 *
 * Widgets: PR-2 drops widgets from the forwarded payload for the same
 * reason PR-1's W1 path did — `EvalTraceWidgetSnapshot.serverId` is
 * `string` (could be a friendly server name from older runs), but
 * `appendEvalTurnTrace`'s validator requires `serverId: v.id('servers')`.
 * The legacy `testIteration.blob` fallback (when flag is off) still
 * carries widgets. A follow-up PR that resolves serverIds at the runner
 * layer (where the MCPClientManager is in scope) will repopulate
 * `sharedChatWidgetSnapshots` for eval rows.
 */

let cachedFlagEnabled: boolean | null = null;
let inFlightFlagQuery: Promise<boolean> | null = null;

export async function isEvalChatSessionsWriterEnabled(
  convexClient: ConvexHttpClient,
): Promise<boolean> {
  if (cachedFlagEnabled !== null) return cachedFlagEnabled;
  if (inFlightFlagQuery) return inFlightFlagQuery;

  inFlightFlagQuery = (async () => {
    try {
      const result = (await convexClient.action(
        "testSuites:isEvalChatSessionsWriterEnabled" as any,
        {},
      )) as { enabled: boolean } | undefined;
      cachedFlagEnabled = result?.enabled === true;
      return cachedFlagEnabled;
    } catch (error) {
      logger.warn(
        "[evals] Failed to query USE_EVAL_CHAT_SESSIONS_WRITER flag; assuming off",
        { error: error instanceof Error ? error.message : String(error) },
      );
      cachedFlagEnabled = false;
      return false;
    } finally {
      inFlightFlagQuery = null;
    }
  })();
  return inFlightFlagQuery;
}

/** Test-only hook. Reset the cache between tests. */
export function __resetEvalChatSessionsWriterFlagCacheForTests(): void {
  cachedFlagEnabled = null;
  inFlightFlagQuery = null;
}

type TurnSlice = {
  promptIndex: number;
  spans: EvalTraceSpan[];
  prompts: PromptTraceSummary[];
  /** Cumulative session messages through this turn. */
  sessionMessages: ModelMessage[];
};

/**
 * Group spans + prompts by `promptIndex` and bucket messages by
 * user-message ordinal. Spans without a `promptIndex` (older traces,
 * step-level spans) attach to the last turn so they're not lost.
 */
function sliceTraceIntoTurns(args: {
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  prompts: PromptTraceSummary[];
}): TurnSlice[] {
  // The set of turn indices we know about — union of spans + prompts
  // indices. Spans with undefined promptIndex go onto the LAST turn so
  // pre-promptIndex traces still land somewhere addressable.
  const promptIndices = new Set<number>();
  for (const span of args.spans) {
    if (typeof span.promptIndex === "number") {
      promptIndices.add(span.promptIndex);
    }
  }
  for (const prompt of args.prompts) {
    promptIndices.add(prompt.promptIndex);
  }
  if (promptIndices.size === 0) {
    promptIndices.add(0);
  }
  const sortedIndices = Array.from(promptIndices).sort((a, b) => a - b);
  const lastIndex = sortedIndices[sortedIndices.length - 1]!;

  // Bucket messages: walk the array, count user messages, attribute each
  // message to the current user-message ordinal as its promptIndex. This
  // matches the eval runner's per-prompt loop semantics (one user
  // message per promptTurn).
  const messageBuckets = new Map<number, ModelMessage[]>();
  for (const idx of sortedIndices) messageBuckets.set(idx, []);
  let currentTurn = sortedIndices[0]!;
  let userOrdinal = -1;
  for (const message of args.messages) {
    if (message.role === "user") {
      userOrdinal += 1;
      const candidate = sortedIndices[userOrdinal];
      if (candidate !== undefined) currentTurn = candidate;
    }
    const bucket = messageBuckets.get(currentTurn);
    if (bucket) bucket.push(message);
  }

  return sortedIndices.map((promptIndex) => {
    const spansForTurn = args.spans.filter((span) => {
      if (typeof span.promptIndex === "number") {
        return span.promptIndex === promptIndex;
      }
      // Span without promptIndex → last turn (lossless).
      return promptIndex === lastIndex;
    });
    const promptsForTurn = args.prompts.filter(
      (p) => p.promptIndex === promptIndex,
    );
    // Cumulative messages through this turn.
    const cumulative: ModelMessage[] = [];
    for (const idx of sortedIndices) {
      if (idx > promptIndex) break;
      cumulative.push(...(messageBuckets.get(idx) ?? []));
    }
    return {
      promptIndex,
      spans: spansForTurn,
      prompts: promptsForTurn,
      sessionMessages: cumulative,
    };
  });
}

type FanoutResult =
  | null
  | { persisted: true }
  | { persisted: false; error: Error };

export async function persistEvalTraceFanout(args: {
  convexClient: ConvexHttpClient;
  iterationId: string;
  /** Used as `chatSessions.displayLabel`. */
  displayLabel?: string;
  /** Real iteration start (ms epoch) — surfaces in `chatSessions.startedAt`.
   *  Falls back to `Date.now()` only when absent. PR-2 review fix #1
   *  (Cursor #a52700dd): the old default-to-finalize-time skewed Sessions
   *  viewer timelines for long-running evals. */
  iterationStartedAt?: number;
  modelId?: string;
  /** Maps to `chatSessions.modelSource`. Defaults to 'mcpjam'. */
  modelSource?: "mcpjam" | "byok" | "local_byok";
  messages: ModelMessage[];
  spans: EvalTraceSpan[] | undefined;
  prompts: PromptTraceSummary[] | undefined;
  /** Currently unused — see file header note about widgets. */
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
}): Promise<FanoutResult> {
  const enabled = await isEvalChatSessionsWriterEnabled(args.convexClient);
  if (!enabled) return null;

  // Avoid touching the widgetSnapshots param so linters don't flag it.
  // Documented in the file header why widgets are PR-2-deferred.
  void args.widgetSnapshots;

  const turns = sliceTraceIntoTurns({
    messages: args.messages,
    spans: args.spans ?? [],
    prompts: args.prompts ?? [],
  });

  const startedAt = args.iterationStartedAt ?? Date.now();
  const modelId = args.modelId ?? "eval/unknown";
  const modelSource = args.modelSource ?? "mcpjam";

  // PR-2 review fix #2 (Cursor #ed44ef40): the fanout no longer fires
  // the chatSessions terminal lock. Callers fire `lockEvalSessionAfterUpdate`
  // explicitly AFTER `updateTestIteration` succeeds so a downstream
  // iteration-row failure cannot leave a locked transcript without a
  // finalized iteration. Idempotent on retry per PR-1 lock semantics
  // (same-promptIndex re-write before lock = patch in place, no-op
  // after lock).
  try {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const now = Date.now();
      const result = (await args.convexClient.action(
        "testSuites:appendEvalTurnTrace" as any,
        {
          iterationId: args.iterationId,
          modelId,
          modelSource,
          ...(args.displayLabel ? { displayLabel: args.displayLabel } : {}),
          startedAt,
          lastActivityAt: now,
          turn: {
            promptIndex: turn.promptIndex,
            turnStartedAt: now,
            turnEndedAt: now,
            sessionMessages: sanitizeForConvexTransport(turn.sessionMessages),
            spans: sanitizeForConvexTransport(turn.spans),
            ...(turn.prompts.length > 0
              ? { prompts: sanitizeForConvexTransport(turn.prompts) }
              : {}),
            widgets: [],
          },
        },
      )) as { skipped?: boolean } | undefined;
      // If the backend reports `skipped: true`, the flag flipped off
      // between our cache check and the per-turn call. Bail out so the
      // caller can fall back to the legacy path.
      if (result?.skipped === true) {
        return {
          persisted: false,
          error: new Error(
            "appendEvalTurnTrace returned skipped:true; flag turned off mid-fanout",
          ),
        };
      }
    }
    return { persisted: true };
  } catch (error) {
    return {
      persisted: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Fires the chatSessions lock via the backend after `updateTestIteration`
 * has succeeded. Idempotent — silently no-ops if the session is already
 * locked or if no chatSessions row was persisted (e.g. the fanout fell
 * back). Best-effort: logs and swallows transient failures because the
 * iteration row is already finalized at the call site and a missed lock
 * is recoverable on the next finalize attempt.
 */
export async function lockEvalSessionAfterUpdate(args: {
  convexClient: ConvexHttpClient;
  iterationId: string;
  reason: "eval_completed" | "eval_failed" | "eval_cancelled";
}): Promise<void> {
  try {
    await args.convexClient.action(
      "testSuites:lockEvalSession" as any,
      { iterationId: args.iterationId, reason: args.reason },
    );
  } catch (error) {
    logger.warn(
      "[evals] lockEvalSession failed after updateTestIteration; transcript will remain unlocked",
      {
        iterationId: args.iterationId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
