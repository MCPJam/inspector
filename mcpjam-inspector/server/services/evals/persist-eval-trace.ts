import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type {
  BrowserInteractionStepPayload,
  EvalTraceSpan,
  EvalTraceWidgetSnapshot,
  PromptTraceSummary,
  SerializedBrowserInteractionStep,
  SerializedWidgetRenderObservation,
  WidgetRenderObservationPayload,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import {
  toBrowserStepPayload,
  toObservationPayload,
} from "./finalize-iteration-browser-artifacts.js";
import {
  evalTraceSnapshotToPayload,
  sanitizeWidgetForBackend,
  type SharedChatWidgetSnapshotPayload,
} from "@/shared/widget-snapshot";

/**
 * Inspector-side per-turn fanout for the eval→chatSessions unification.
 *
 * Both `recorder.finishIteration` (multi-iteration suite runs) and
 * `finishIterationDirectly` (quick runs without a recorder) receive the
 * final accumulated transcript at end-of-iteration. We want N
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
 * Return values (`turnsWritten` counts turn-trace rows the backend
 * acknowledged):
 *   - `{ persisted: true, turnsWritten }`: every turn was written.
 *     Caller should call `updateTestIteration` with status/result and
 *     metadata ONLY. Passing trace fields would re-fire
 *     `persistEvalTraceAction` on the W1 path and either silently
 *     no-op against the now-locked session or throw EVAL_SESSION_LOCKED.
 *   - `{ persisted: false, turnsWritten: 0, error }`: fanout failed
 *     BEFORE any turn landed. Caller should fall back to the W1
 *     single-call path by passing `messages`/`spans`/`prompts`/
 *     `widgetSnapshots` to `updateTestIteration`. The backend writes a
 *     fresh chatSessions row at `promptIndex: 0` with the full
 *     transcript. No orphan risk because no turn-trace rows exist yet.
 *   - `{ persisted: false, turnsWritten: N (>0), error }`: fanout
 *     failed mid-stream after N turns wrote successfully. Caller must
 *     NOT re-send trace fields — W1 would overwrite turn 0 and orphan
 *     turns 1..N-1. The partial chatSessions row stays as-is; the
 *     reader tolerates it.
 *
 * Widgets: forwarded on the LAST turn call so they persist once at
 * finalize. Inspector capture (`captureMcpAppWidgetSnapshots`) supplies
 * the friendly MCP server name as `serverId`; the backend resolves it
 * to a Convex `Id<'servers'>` via `resolveEvalWidgetServerIds` before
 * writing `sharedChatWidgetSnapshots`. Widgets whose serverId can't be
 * resolved against the iteration's project/workspace, or whose HTML
 * blob upload failed, are dropped — the persist call must not fail
 * over a single bad widget.
 */

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

/**
 * Translate the eval runner's captured snapshots to the shared
 * `sharedChatWidgetSnapshots` payload shape and run them through the
 * Convex transport sanitizer. The mapping + CSP normalization + $-key
 * sanitization all live in `shared/widget-snapshot.ts` so every writer
 * to that table (playground hook, synthetic runner, eval) goes through
 * the same pipeline.
 */
function serializeWidgetsForBackend(
  snapshots: EvalTraceWidgetSnapshot[] | undefined,
): SharedChatWidgetSnapshotPayload[] {
  if (!snapshots || snapshots.length === 0) return [];
  const out: SharedChatWidgetSnapshotPayload[] = [];
  for (const snap of snapshots) {
    const payload = evalTraceSnapshotToPayload(snap);
    if (!payload) continue;
    out.push(sanitizeWidgetForBackend(payload));
  }
  return out;
}

type FanoutResult =
  | { persisted: true; turnsWritten: number }
  | { persisted: false; turnsWritten: number; error: Error };

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
  /**
   * Eval widget snapshots captured via `captureMcpAppWidgetSnapshots`.
   * Attached to the LAST turn call so they persist once, at finalize.
   * The backend resolves the friendly `serverId` to a Convex doc id
   * (`resolveEvalWidgetServerIds`); unresolved widgets are dropped
   * server-side, not here.
   */
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  /**
   * Resolved system prompt for the eval session. Persisted to
   * `chatSessions.systemPrompt` by the backend with **first-write-wins**
   * semantics — the value is invariant per eval session, so subsequent
   * per-turn calls carrying the same field are ignored. Replaces the
   * pre-PR persistence-side `{role:"system", ...}` prepend each runner
   * used to splice into `messages` at finalize.
   */
  systemPrompt?: string;
  /**
   * PR 6b: browser-rendered MCP App render observations + interaction steps,
   * ALREADY uploaded + sanitized by `finalizeEvalIteration`. This function
   * must NOT upload screenshots. Each record keeps `promptIndex` so it buckets
   * onto its own turn (their natural emission cadence — unlike widgets, which
   * attach to the last turn only). `promptIndex` is stripped before the backend
   * turn payload; the backend re-stamps it from `turn.promptIndex`.
   */
  widgetRenderObservations?: SerializedWidgetRenderObservation[];
  browserInteractionSteps?: SerializedBrowserInteractionStep[];
  /**
   * Convex storageId for the iteration's replay `.webm`, already uploaded by
   * `finalizeEvalIteration`. Iteration-level (one video per iteration), so it
   * attaches to the LAST turn call only — mirroring `widgetSnapshots` — and the
   * backend stores it on the iteration/session trace for `getTestIterationBlob`
   * to resolve into a `videoUrl`.
   */
  videoBlobId?: string;
}): Promise<FanoutResult> {
  const turns = sliceTraceIntoTurns({
    messages: args.messages,
    spans: args.spans ?? [],
    prompts: args.prompts ?? [],
  });

  // Bucket the (already-serialized) browser artifacts by promptIndex so each
  // turn carries only its own observations/steps. The backend dedups
  // observations by (sessionId, toolCallId) and steps by
  // (sessionId, toolCallId, stepIndex), so a same-turn retry is idempotent.
  const obsByPromptIndex = new Map<number, WidgetRenderObservationPayload[]>();
  for (const obs of args.widgetRenderObservations ?? []) {
    const arr = obsByPromptIndex.get(obs.promptIndex) ?? [];
    arr.push(toObservationPayload(obs));
    obsByPromptIndex.set(obs.promptIndex, arr);
  }
  const stepsByPromptIndex = new Map<number, BrowserInteractionStepPayload[]>();
  for (const step of args.browserInteractionSteps ?? []) {
    const arr = stepsByPromptIndex.get(step.promptIndex) ?? [];
    arr.push(toBrowserStepPayload(step));
    stepsByPromptIndex.set(step.promptIndex, arr);
  }

  // Convert inspector-shape widgets to the backend `appendEvalTurnTrace`
  // shape. Inspector snapshots optionally carry the HTML blob id;
  // `sharedChatWidgetSnapshots.widgetHtmlBlobId` is required so widgets
  // without an uploaded blob are dropped here. Field renames:
  // `protocol` → `uiType`. Free-form `toolMetadata` is dropped — the
  // backend persists tool input/output as separately-uploaded blobs,
  // not the inline metadata object.
  const lastTurnWidgets = serializeWidgetsForBackend(args.widgetSnapshots);

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
  let turnsWritten = 0;
  try {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const isLastTurn = i === turns.length - 1;
      const now = Date.now();
      // Widgets are session-scoped (`sharedChatWidgetSnapshots` keys on
      // sessionId + toolCallId) and capture happens once per iteration at
      // finalize, so we attach the full set to the last turn call. Earlier
      // turns send `widgets: []` to keep per-turn payloads light.
      const widgetsForThisTurn = isLastTurn ? lastTurnWidgets : [];
      // Observations + steps attach PER turn (their natural emission cadence),
      // unlike last-turn-only widgets. Omitted entirely when empty so the
      // wire shape of non-Computer-Use evals is unchanged.
      const obsForThisTurn = obsByPromptIndex.get(turn.promptIndex) ?? [];
      const stepsForThisTurn = stepsByPromptIndex.get(turn.promptIndex) ?? [];
      const result = (await args.convexClient.action(
        "testSuites:appendEvalTurnTrace" as any,
        {
          iterationId: args.iterationId,
          modelId,
          modelSource,
          ...(args.displayLabel ? { displayLabel: args.displayLabel } : {}),
          startedAt,
          lastActivityAt: now,
          // First-write-wins on the backend; safe to send on every turn
          // call. Replaces the pre-PR persistence-side prepend each
          // runner used to splice into `messages` at finalize.
          ...(args.systemPrompt !== undefined
            ? { systemPrompt: args.systemPrompt }
            : {}),
          // Iteration-level replay video: attach to the last turn only (like
          // widgetSnapshots). Backend stores it on the iteration trace.
          ...(isLastTurn && args.videoBlobId
            ? { videoBlobId: args.videoBlobId }
            : {}),
          turn: {
            promptIndex: turn.promptIndex,
            turnStartedAt: now,
            turnEndedAt: now,
            sessionMessages: sanitizeForConvexTransport(turn.sessionMessages),
            spans: sanitizeForConvexTransport(turn.spans),
            ...(turn.prompts.length > 0
              ? { prompts: sanitizeForConvexTransport(turn.prompts) }
              : {}),
            widgets: widgetsForThisTurn,
            ...(obsForThisTurn.length
              ? { widgetRenderObservations: obsForThisTurn }
              : {}),
            ...(stepsForThisTurn.length
              ? { browserInteractionSteps: stepsForThisTurn }
              : {}),
          },
        },
      )) as { skipped?: boolean } | undefined;
      // If the backend reports `skipped: true`, the flag flipped off
      // between our cache check and the per-turn call. Bail out so the
      // caller can decide whether to fall back to the W1 single-call path.
      if (result?.skipped === true) {
        return {
          persisted: false,
          turnsWritten,
          error: new Error(
            "appendEvalTurnTrace returned skipped:true; flag turned off mid-fanout",
          ),
        };
      }
      turnsWritten += 1;
    }
    return { persisted: true, turnsWritten };
  } catch (error) {
    return {
      persisted: false,
      turnsWritten,
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
