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
 * Widgets: forwarded on the LAST turn call so they persist once at
 * finalize. Inspector capture (`captureMcpAppWidgetSnapshots`) supplies
 * the friendly MCP server name as `serverId`; the backend resolves it
 * to a Convex `Id<'servers'>` via `resolveEvalWidgetServerIds` before
 * writing `sharedChatWidgetSnapshots`. Widgets whose serverId can't be
 * resolved against the iteration's project/workspace, or whose HTML
 * blob upload failed, are dropped — the persist call must not fail
 * over a single bad widget.
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

/**
 * Backend `appendEvalTurnTrace` widget shape (after renames). Kept inline
 * rather than imported from `@convex` to avoid pulling generated types
 * into the inspector server bundle. Mirror of
 * `appendEvalTurnTraceWidgetValidator` in
 * `mcpjam-backend/convex/testSuites.ts`.
 */
type BackendEvalWidget = {
  toolCallId: string;
  toolName: string;
  /** Friendly MCP server name; backend resolves to Id<'servers'>. */
  serverId: string;
  widgetHtmlBlobId: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  widgetCsp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  widgetPermissions?: unknown;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
};

function toStringArrayOrUndefined(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeWidgetCsp(
  v: unknown,
): BackendEvalWidget["widgetCsp"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  const out: BackendEvalWidget["widgetCsp"] = {};
  const connect = toStringArrayOrUndefined(rec.connectDomains);
  const resource = toStringArrayOrUndefined(rec.resourceDomains);
  const frame = toStringArrayOrUndefined(rec.frameDomains);
  const base = toStringArrayOrUndefined(rec.baseUriDomains);
  if (connect) out.connectDomains = connect;
  if (resource) out.resourceDomains = resource;
  if (frame) out.frameDomains = frame;
  if (base) out.baseUriDomains = base;
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeWidgetsForBackend(
  snapshots: EvalTraceWidgetSnapshot[] | undefined,
): BackendEvalWidget[] {
  if (!snapshots || snapshots.length === 0) return [];
  const out: BackendEvalWidget[] = [];
  for (const snap of snapshots) {
    if (!snap.widgetHtmlBlobId) {
      // Required by `sharedChatWidgetSnapshots.widgetHtmlBlobId`. The
      // capture path uploads when it can; widgets without an uploaded
      // blob are unusable to the reader and dropped here.
      continue;
    }
    const widget: BackendEvalWidget = {
      toolCallId: snap.toolCallId,
      toolName: snap.toolName,
      serverId: snap.serverId,
      widgetHtmlBlobId: snap.widgetHtmlBlobId,
      uiType: snap.protocol,
    };
    if (snap.resourceUri) widget.resourceUri = snap.resourceUri;
    const csp = normalizeWidgetCsp(snap.widgetCsp);
    if (csp) widget.widgetCsp = csp;
    if (snap.widgetPermissions !== undefined && snap.widgetPermissions !== null) {
      widget.widgetPermissions = snap.widgetPermissions;
    }
    if (typeof snap.widgetPermissive === "boolean") {
      widget.widgetPermissive = snap.widgetPermissive;
    }
    if (typeof snap.prefersBorder === "boolean") {
      widget.prefersBorder = snap.prefersBorder;
    }
    // `widgetPermissions` is free-form `Record<string, unknown>` on the
    // wire (typed `v.any()` server-side). JSON Schema fragments commonly
    // appear there and use `$`-prefixed keys (`$ref`, `$schema`), which
    // Convex rejects at the argument validator boundary, failing the
    // whole `appendEvalTurnTrace` call and killing the fanout. Sanitize
    // the widget so any `$`-prefixed key is escaped to
    // `__convexReserved__*` for transport — same protection
    // `sessionMessages` / `spans` / `prompts` already get.
    out.push(sanitizeForConvexTransport(widget));
  }
  return out;
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
  /**
   * Eval widget snapshots captured via `captureMcpAppWidgetSnapshots`.
   * Attached to the LAST turn call so they persist once, at finalize.
   * The backend resolves the friendly `serverId` to a Convex doc id
   * (`resolveEvalWidgetServerIds`); unresolved widgets are dropped
   * server-side, not here.
   */
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
}): Promise<FanoutResult> {
  const enabled = await isEvalChatSessionsWriterEnabled(args.convexClient);
  if (!enabled) return null;

  const turns = sliceTraceIntoTurns({
    messages: args.messages,
    spans: args.spans ?? [],
    prompts: args.prompts ?? [],
  });

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
            widgets: widgetsForThisTurn,
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
