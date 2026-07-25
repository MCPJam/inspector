/**
 * Wire types for the hosted **multi-round-trip (`input_required` / MRTR)**
 * continuation transport (MCP 2026-07-28 spec §12.5).
 *
 * ## Why this is not `hosted-elicitation`
 *
 * Legacy `elicitation/create` (see `shared/hosted-elicitation.ts`) is an
 * unsolicited server→client request that arrives mid-`tools/call`; the hosted
 * worker BLOCKS on the SSE stream while a human answers (bounded by a short
 * TTL). MRTR is different: a modern `tools/call` / `prompts/get` /
 * `resources/read` can *return* an `input_required` result, and §12.5.2 forbids
 * the worker from blocking. The operation is therefore SUSPENDED to a durable
 * Convex continuation record (PR3a) and the worker returns; a fresh
 * authenticated request re-drives it on any replica after the human answers.
 *
 * The browser holds ONLY an opaque `continuationId`. The `requestState`, the
 * original operation params, the round counter, and the collected responses all
 * live server-side. This data part therefore carries a **safe display** of each
 * embedded request (mode + message + the form schema, or the URL) — never the
 * raw `requestState`, never unbounded content, never the original params.
 *
 * These parts are `transient: true` at the write site (like `data-elicitation`):
 * they reach the AI SDK `onData` callback but never enter `message.parts`,
 * because an in-flight MRTR prompt is turn-scoped UI, not conversation history.
 */

/**
 * Version of the hosted-MRTR wire contract the client speaks, sent on every
 * chat request as `hostedMrtrVersion`.
 *
 * The server drives the durable MRTR continuation path only when it sees this
 * AND the host declares `elicitation` (an `input_required` round always embeds
 * an `elicitation/create`, so the capability gate is the same as legacy
 * elicitation's). Without a handshake a stale browser bundle — which cannot
 * render an MRTR prompt or POST a resume — would be handed a `continuationId`
 * it can do nothing with, and the operation would hang until its continuation
 * TTL. A version-mismatched client instead **fails fast** (the server declines
 * the round rather than suspending). Bump only on an incompatible change to the
 * parts below.
 */
export const HOSTED_MRTR_VERSION = 1;

/** The three verbs that can enter an MRTR loop (spec §12.1). */
export type MrtrOperationMethod =
  | "tools/call"
  | "prompts/get"
  | "resources/read";

/** Elicitation delivery mode inside an MRTR round. Absent ⇒ `"form"`. */
export type MrtrElicitationMode = "form" | "url";

/** The action the browser submits for one embedded elicitation. */
export type MrtrElicitationAction = "accept" | "decline" | "cancel";

/** Terminal outcomes the server reports back for a continuation. */
export type MrtrContinuationOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * A SAFE display of one embedded `elicitation/create` request in the current
 * round, keyed by the server's (untrusted) request key.
 *
 * Deliberately narrow: only what a dialog needs to render. It never carries the
 * opaque `requestState`, the original operation params, or any server-minted
 * correlation id used as an authorization key.
 */
export interface MrtrInputRequestDisplay {
  /** The server's request key; the browser echoes it back in its response map. */
  key: string;
  mode: MrtrElicitationMode;
  /** Human-facing prompt text. Capped at the producer. */
  message: string;
  /** Form mode: the MCP `requestedSchema` (flat-object subset). Capped. */
  requestedSchema?: unknown;
  /** URL mode: the URL the user is asked to open. Never pre-fetched. */
  url?: string;
}

/**
 * A hosted MRTR operation suspended awaiting input. The tool/prompt/resource
 * call is paused server-side against a durable continuation record.
 *
 * `continuationId` is the replica-minted opaque handle the browser answers on
 * (via the authenticated `/mrtr/continuation/resume` route). It is NEVER a
 * server-chosen id.
 */
export interface MrtrInputRequiredEvent {
  kind: "input_required";
  /** Handshake echo so a stale browser can detect a version it cannot honor. */
  version: number;
  continuationId: string;
  /**
   * The MCP server that issued the round. `serverId` is the trusted, immutable
   * anchor; `serverName` is a display label only (MCP §Security: the client
   * must make it clear which server is asking).
   */
  serverId: string;
  serverName?: string;
  method: MrtrOperationMethod;
  /** Safe operation label, e.g. a tool name. Capped; display only. */
  operationLabel?: string;
  /** 0-based round index this prompt belongs to (drives idempotent resume). */
  round: number;
  /** The embedded elicitations for this round. At least one. */
  inputRequests: MrtrInputRequestDisplay[];
  /** Epoch ms after which the continuation expires and resolves as cancel. */
  expiresAt: number;
  chatSessionId?: string;
}

/**
 * A continuation reached a terminal state server-side. Sent so an open dialog
 * closes even when the browser was not what resolved it (TTL expiry, a resume
 * that completed the operation, a cancel from elsewhere).
 */
export interface MrtrResolvedEvent {
  kind: "resolved";
  version: number;
  continuationId: string;
  outcome: MrtrContinuationOutcome;
  /**
   * `true` when a side-effecting `tools/call` may or may not have executed
   * (worker died mid-wire). The UI must NOT auto-retry — it surfaces an explicit
   * user retry decision. Mirrors PR3a's `indeterminate` terminal state.
   */
  indeterminate?: boolean;
}

export type MrtrContinuationEvent = MrtrInputRequiredEvent | MrtrResolvedEvent;

/** Wire literal for the stream data part carrying a `MrtrContinuationEvent`. */
export const HOSTED_MRTR_DATA_PART_TYPE = "data-mrtr-input-required" as const;

export interface MrtrContinuationDataPart {
  type: typeof HOSTED_MRTR_DATA_PART_TYPE;
  data: MrtrContinuationEvent;
}

/**
 * The answer the browser submits to resume a suspended continuation. Keyed by
 * `continuationId` + `round`; the server re-derives ownership from the caller's
 * verified identity and enforces an idempotent, round-keyed transition, so this
 * payload is not trusted for authorization.
 */
export interface MrtrResumeSubmission {
  continuationId: string;
  /** Must equal the pending round; a mismatch is rejected as a stale submit. */
  round: number;
  /** One response per embedded request key from the round's display. */
  responses: Record<string, MrtrElicitationResponse>;
}

/**
 * The browser's bare response for one embedded elicitation, mirroring MCP's
 * `ElicitResult`. `content` rides ONLY on a form-mode accept.
 */
export interface MrtrElicitationResponse {
  action: MrtrElicitationAction;
  content?: Record<string, unknown>;
}

// ── Type guards ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isMethod(value: unknown): value is MrtrOperationMethod {
  return (
    value === "tools/call" ||
    value === "prompts/get" ||
    value === "resources/read"
  );
}

function isAction(value: unknown): value is MrtrElicitationAction {
  return value === "accept" || value === "decline" || value === "cancel";
}

function isInputRequestDisplay(
  value: unknown,
): value is MrtrInputRequestDisplay {
  if (!isRecord(value)) return false;
  if (typeof value.key !== "string" || typeof value.message !== "string") {
    return false;
  }
  if (value.mode === "url") return typeof value.url === "string";
  if (value.mode === "form") return true;
  return false;
}

/**
 * Validates a `data-mrtr-input-required` payload before consumers treat it as
 * typed. Strict about optional fields, not just required ones — this guard is
 * what stands between a malformed part and UI that dereferences it.
 *
 * A `version` mismatch is NOT rejected here: version handling is a caller
 * decision (a stale browser should recognize the newer part enough to show a
 * "please refresh" affordance rather than silently drop it). Use
 * {@link isCompatibleMrtrVersion} for the gate.
 */
export function isMrtrContinuationEvent(
  value: unknown,
): value is MrtrContinuationEvent {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number") return false;
  if (typeof value.continuationId !== "string") return false;

  if (value.kind === "input_required") {
    return (
      typeof value.serverId === "string" &&
      isOptionalString(value.serverName) &&
      isMethod(value.method) &&
      isOptionalString(value.operationLabel) &&
      typeof value.round === "number" &&
      Number.isFinite(value.round) &&
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt) &&
      isOptionalString(value.chatSessionId) &&
      Array.isArray(value.inputRequests) &&
      value.inputRequests.length > 0 &&
      value.inputRequests.every(isInputRequestDisplay)
    );
  }

  if (value.kind === "resolved") {
    return (
      (value.outcome === "completed" ||
        value.outcome === "failed" ||
        value.outcome === "cancelled" ||
        value.outcome === "expired") &&
      (value.indeterminate === undefined ||
        typeof value.indeterminate === "boolean")
    );
  }

  return false;
}

export function isMrtrContinuationDataPart(
  value: unknown,
): value is MrtrContinuationDataPart {
  if (!isRecord(value)) return false;
  return (
    value.type === HOSTED_MRTR_DATA_PART_TYPE &&
    isMrtrContinuationEvent(value.data)
  );
}

/**
 * Whether a part authored at `partVersion` can be honored by a consumer that
 * speaks {@link HOSTED_MRTR_VERSION}. Exact-match: an MRTR round is a
 * multi-step protocol (suspend → display → resume) where a partial
 * understanding is worse than none, so a mismatched browser fails fast (shows a
 * refresh prompt) instead of half-rendering a round it cannot complete.
 */
export function isCompatibleMrtrVersion(partVersion: number): boolean {
  return partVersion === HOSTED_MRTR_VERSION;
}

/**
 * Validate a browser resume submission's SHAPE (not its authorization). The
 * server still re-validates ownership, the round fence, and each response
 * against its `requestedSchema`; this only rejects a structurally broken body
 * before it reaches the continuation store.
 */
export function isMrtrResumeSubmission(
  value: unknown,
): value is MrtrResumeSubmission {
  if (!isRecord(value)) return false;
  if (typeof value.continuationId !== "string") return false;
  if (typeof value.round !== "number" || !Number.isFinite(value.round)) {
    return false;
  }
  if (!isRecord(value.responses)) return false;
  return Object.values(value.responses).every(
    (r) =>
      isRecord(r) &&
      isAction(r.action) &&
      (r.content === undefined || isRecord(r.content)),
  );
}
