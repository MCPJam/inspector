/**
 * Transient SSE data part reporting what happened to a turn's chat-history save.
 *
 * The server awaits the Convex ingest before it closes the stream — it has the
 * answer in hand. Before this part existed it discarded that answer, and the
 * client tried to infer save success from the outside by polling the session's
 * `version` over REST. That poll could not tell "the save failed" from "another
 * device edited this thread", so a plain persistence failure surfaced as a
 * concurrency alarm and forced the user into a new thread. The receipt replaces
 * an inference with a statement of fact.
 *
 * Transient (never persisted): it describes THIS turn's write, not conversation
 * content. Emitted after the `finish` chunk, before the stream closes. Costs no
 * added latency — the persist already gates the close.
 *
 * Older clients drop unknown data parts by design, so adding this is additive:
 * a new server can stream it to an old client harmlessly.
 */

export const PERSIST_RECEIPT_PART_TYPE = "data-persist-receipt" as const;

/**
 * - `saved`     — committed; `version` is the session's new write generation.
 * - `duplicate` — the backend recognized this exact turn as already applied
 *                 (a retry whose first response was lost). As good as saved.
 * - `skipped`   — the backend's legacy replay heuristic discarded the write.
 *                 A possible lost turn, not a save.
 * - `conflict`  — the session moved on underneath this turn; the transcript was
 *                 refused to avoid clobbering another writer.
 * - `failed`    — the save did not demonstrably happen. AMBIGUOUS on purpose: a
 *                 timed-out ingest may still have committed server-side, so a
 *                 client must reconcile before telling the user anything.
 */
export type PersistReceiptOutcome =
  | "saved"
  | "duplicate"
  | "skipped"
  | "conflict"
  | "failed";

export type PersistReceiptFailureKind =
  | "timeout"
  | "http_error"
  | "protocol_error"
  | "exception";

export interface PersistReceiptData {
  outcome: PersistReceiptOutcome;
  /**
   * The session this receipt is about. The client MUST check it against the
   * session that is live before acting: a receipt arriving after a reset, fork,
   * or thread switch belongs to a conversation that is no longer on screen.
   */
  chatSessionId: string;
  /** The turn this receipt is about, when the rail carries turn identity. */
  turnId?: string;
  /** New session version. Present for `saved`/`duplicate`, and for `skipped`. */
  version?: number;
  /** The version the session actually holds. Present for `conflict`. */
  currentVersion?: number;
  /** Why the save failed. Present for `failed`. */
  failureKind?: PersistReceiptFailureKind;
}

export interface PersistReceiptDataPart {
  type: typeof PERSIST_RECEIPT_PART_TYPE;
  data: PersistReceiptData;
}

const PERSIST_RECEIPT_OUTCOMES: ReadonlySet<PersistReceiptOutcome> = new Set([
  "saved",
  "duplicate",
  "skipped",
  "conflict",
  "failed",
]);

export function isPersistReceiptDataPart(
  value: unknown
): value is PersistReceiptDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== PERSIST_RECEIPT_PART_TYPE) {
    return false;
  }
  const data = candidate.data;
  if (!data || typeof data !== "object") {
    return false;
  }
  const { outcome, chatSessionId, version, currentVersion } = data as Record<
    string,
    unknown
  >;
  // `chatSessionId` is required, not optional: without it the client cannot
  // tell whether the receipt describes the thread it is currently showing, and
  // an unattributable receipt is worse than none. The versions are checked for
  // the same reason — the client syncs its concurrency baseline from `version`,
  // so a non-numeric one would flow straight into that baseline.
  return (
    typeof outcome === "string" &&
    PERSIST_RECEIPT_OUTCOMES.has(outcome as PersistReceiptOutcome) &&
    typeof chatSessionId === "string" &&
    chatSessionId.length > 0 &&
    (version === undefined || Number.isFinite(version)) &&
    (currentVersion === undefined || Number.isFinite(currentVersion))
  );
}
