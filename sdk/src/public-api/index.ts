/**
 * MCPJam Public API — v1 contract (shared source of truth).
 *
 * Framework-agnostic: NO Hono, Convex, or Node imports, and no runtime
 * dependencies, so every public-API surface can import it cheaply (the same
 * discipline as `@mcpjam/sdk/host-config/internal`). It defines the wire
 * contract — the error-code union, the code -> HTTP-status map, the
 * internal -> public code mapping, and the envelope/pagination builders.
 *
 * Consumers:
 *   - the Inspector Hono gateway (`mcpjam-inspector/server/routes/v1`) imports
 *     this and adapts it to `c.json(...)` in its `envelope.ts`.
 *   - the Convex backend (`mcpjam-backend/convex/publicApi`) will consume this
 *     once its pinned `@mcpjam/sdk` version includes the subpath; until then it
 *     keeps a byte-identical local copy, cross-checked by golden fixtures.
 *
 * Envelope rules:
 *   - success (single resource) -> the resource object directly
 *   - success (collection)      -> { items, nextCursor? }   (cursor-based)
 *   - error                     -> { code, message, details? }  + HTTP status
 *
 * Framework-specific response helpers (Hono `c.json`, platform `Response`)
 * intentionally live with each consumer, not here. So does anything a
 * particular HOST needs: the agent types below carry a kind and a severity,
 * never Slack wording or Block Kit — a second wrapper must be a rendering
 * file, not a protocol change.
 */

/**
 * Canonical v1 public error-code union.
 *
 * Reconciliation note: the Inspector Node already ships
 * UNAUTHORIZED/FORBIDDEN/NOT_FOUND/VALIDATION_ERROR/RATE_LIMITED/
 * FEATURE_NOT_SUPPORTED/SERVER_UNREACHABLE/TIMEOUT/INTERNAL_ERROR (see
 * routes/web/errors.ts `ErrorCode`). The public union adopts those verbatim and
 * adds OAUTH_REQUIRED so callers (our MCP worker, CLI, agents) can distinguish
 * "this server needs an OAuth grant" from a generic 401. Draft-only codes
 * UPSTREAM_ERROR/TOOL_TIMEOUT are NOT public; they collapse to
 * SERVER_UNREACHABLE/TIMEOUT at the boundary (see INTERNAL_TO_V1_CODE). Adding
 * codes is backward-compatible; removing or repurposing one is breaking.
 *
 * CONFLICT (409) covers a write rejected because the resource is not in a state
 * that accepts it — the caller's request was well-formed, so VALIDATION_ERROR
 * would misreport it, and retrying verbatim will not help. Project Environments
 * are the first surface to need it: they use optimistic concurrency, so a stale
 * `expectedRevision` must be distinguishable from bad input. It also carries the
 * environment name collisions and archive-state rejections the backend reports
 * with the same code, and the run-start `ENVIRONMENT_REVISION_CONFLICT`, which
 * previously had no public mapping and so surfaced as a 500.
 */
export const V1_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "FEATURE_NOT_SUPPORTED",
  "SERVER_UNREACHABLE",
  "TIMEOUT",
  "OAUTH_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type V1ErrorCode = (typeof V1_ERROR_CODES)[number];

export function isV1ErrorCode(value: unknown): value is V1ErrorCode {
  return (
    typeof value === "string" &&
    (V1_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Canonical error body. `details` is an opaque, JSON-serializable bag. */
export interface V1ErrorBody {
  code: V1ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Canonical collection envelope. Cursor is opaque to the caller. */
export interface V1Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Canonical code -> HTTP status mapping. */
export const V1_ERROR_STATUS: Record<V1ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  FEATURE_NOT_SUPPORTED: 422,
  SERVER_UNREACHABLE: 502,
  TIMEOUT: 504,
  OAUTH_REQUIRED: 401,
  INTERNAL_ERROR: 500,
};

/**
 * Internal/draft code -> public v1 code. Used at the surface boundary to map
 * whatever an internal handler threw (Inspector `ErrorCode`) onto the public
 * union. The 9 shipped Inspector codes map to themselves; the draft-only codes
 * collapse onto their canonical equivalents.
 */
export const INTERNAL_TO_V1_CODE: Record<string, V1ErrorCode> = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UPSTREAM_ERROR: "SERVER_UNREACHABLE",
  OAUTH_REQUIRED: "OAUTH_REQUIRED",
  TOOL_TIMEOUT: "TIMEOUT",
  // The eval run-start revision conflict. Internally its own code so the
  // hosted UI can render a bespoke "environment changed — retry" message;
  // publicly it is just a CONFLICT. Without this entry it fell through
  // `mapInternalCode`'s default and reached API callers as a 500.
  ENVIRONMENT_REVISION_CONFLICT: "CONFLICT",
  // The target MCP server refused the credentials we presented (401/403/400
  // per the MCP authorization spec's error table). Internally its own code so
  // the hosted UI can say "reconnect this server"; publicly it collapses onto
  // FORBIDDEN — the public union has no upstream-auth member, and FORBIDDEN
  // carries the property that matters to an API caller: retrying with a
  // different MCPJam credential will not help. Same trap as
  // ENVIRONMENT_REVISION_CONFLICT above — without this entry it falls through
  // `mapInternalCode`'s default and reaches API callers as a 500, which is
  // exactly the misreport the internal code was introduced to end.
  UPSTREAM_AUTH_FAILED: "FORBIDDEN",
  // The organization's billing allowance is exhausted — `launch-journey-run`
  // raises this from an upstream 402, and the reservation ledger's refusals
  // reach the surface the same way. Publicly FORBIDDEN, for the same reason as
  // the entry above: the public union has no billing member, and FORBIDDEN
  // carries the property an API caller needs — the key is valid, this account
  // may not do this right now, and retrying the same call will not change
  // that. Without this entry it fell through to a 500, which told a customer
  // that MCPJam broke when the truth was that their credit ran out, AND paged
  // the on-call for a state only that customer can resolve.
  //
  // Deliberately not RATE_LIMITED: a daily cap that lifts at UTC midnight is a
  // 429 with a `Retry-After` (see `convex-errors.ts`), and telling a caller to
  // wait for money to appear would be the same lie in the other direction.
  BILLING_LIMIT_REACHED: "FORBIDDEN",
  // Registry / directory install family (mcpjam-backend publicApi contract).
  // Copied from convex/publicApi/__fixtures__/internal-to-v1-code.json — do
  // not retype. The inspector fixture keeps BILLING_LIMIT_REACHED (inspector-
  // only) plus these entries; the backend fixture is the same minus billing.
  endpoint_url_required: "VALIDATION_ERROR",
  endpoint_url_invalid: "VALIDATION_ERROR",
  endpoint_url_not_configurable: "VALIDATION_ERROR",
  endpoint_url_not_allowed: "VALIDATION_ERROR",
  already_connected_to_different_endpoint: "CONFLICT",
  server_name_conflict: "CONFLICT",
  registry_server_name_conflict: "CONFLICT",
  catalog_server_removed: "CONFLICT",
  catalog_server_not_connectable: "CONFLICT",
  catalog_server_missing_endpoint: "CONFLICT",
  endpoint_pattern_unusable: "CONFLICT",
  catalog_server_changed: "CONFLICT",
  registry_server_changed: "CONFLICT",
  catalog_server_not_found: "NOT_FOUND",
  registry_server_not_found: "NOT_FOUND",
  registry_connection_not_found: "NOT_FOUND",
  registry_server_not_approved: "FORBIDDEN",
  registry_project_org_mismatch: "FORBIDDEN",
};

export function mapInternalCode(code: string | undefined | null): V1ErrorCode {
  if (code && Object.prototype.hasOwnProperty.call(INTERNAL_TO_V1_CODE, code)) {
    return INTERNAL_TO_V1_CODE[code];
  }
  return "INTERNAL_ERROR";
}

/** Build a canonical error body (drops an empty `details` bag). */
export function v1ErrorBody(
  code: V1ErrorCode,
  message: string,
  details?: Record<string, unknown>
): V1ErrorBody {
  return {
    code,
    message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

/** Build a canonical collection body (omits `nextCursor` when absent). */
export function v1Page<T>(items: T[], nextCursor?: string): V1Page<T> {
  return nextCursor ? { items, nextCursor } : { items };
}

// ── Agent turn ────────────────────────────────────────────────────────
//
// The wire contract for `POST /projects/{projectId}/agent` and the approval
// round trip it can start. These types are SURFACE-NEUTRAL on purpose: Slack
// is the first host, Discord is the next, and neither one's wording, button
// grammar, or block format belongs in a shared contract. What travels is
// metadata the host renders in its own idiom — a kind, a severity, a label —
// so a new wrapper is a rendering file, not a protocol change.

/**
 * What an approved action DOES, coarsely, so a host can word its confirmation
 * and its after-the-fact announcement truthfully.
 *
 * The announcement is the reason this exists rather than the host switching on
 * the operation name: "it's away" is true of a run and false of a cancellation,
 * and telling someone their cancel started something is the kind of small lie
 * that costs trust in every later message. Hosts that do not recognise a kind
 * must fall back to neutral copy, never to a guess.
 *
 * - `start` — begins work that will run for a while (a suite/case run).
 * - `cancel` — stops work that is already running.
 * - `generate` — authors content in the background.
 * - `schedule` — changes a recurring setting; nothing starts right now.
 * - `external` — reaches a third-party system whose effects MCPJam cannot
 *   describe, undo, or bound.
 */
export const PROPOSED_ACTION_KINDS = [
  "start",
  "cancel",
  "generate",
  "schedule",
  "external",
] as const;

export type ProposedActionKind = (typeof PROPOSED_ACTION_KINDS)[number];

/**
 * What the host should warn about, beyond "you are approving something".
 *
 * Absent means "the ordinary approval prompt is honest enough". Present names
 * the specific claim the host must make, and `none` exists because a default
 * prompt is not neutral: hosts word theirs around cost, so an action that
 * COSTS NOTHING needs to say so rather than inherit a warning that is false.
 *
 * - `spend` — consumes quota or credits, possibly repeatedly.
 * - `external` — runs somewhere MCPJam does not control and cannot undo.
 * - `none` — costs nothing (e.g. turning a schedule OFF). The host must not
 *   claim it uses quota.
 */
export const PROPOSED_ACTION_SEVERITIES = [
  "spend",
  "external",
  "none",
] as const;

export type ProposedActionSeverity =
  (typeof PROPOSED_ACTION_SEVERITIES)[number];

/**
 * An action the turn wants to take but may not take on its own.
 *
 * `actionId` is the ONLY thing a host's approval control needs to carry. What
 * the action does is held server-side against that id, because an approval
 * control's payload is mintable by anyone who can post in the host workspace —
 * a click may say WHICH proposal to run, never what it does. The rest of the
 * fields are for RENDERING and nothing else; a host that echoed `operation`
 * back as an instruction would be re-opening the hole `actionId` closes.
 */
export interface ProposedAction {
  actionId: string;
  /** Platform operation name. Display/telemetry only — never an instruction. */
  operation: string;
  /** Short, concrete summary of the target. Host-escaped before rendering. */
  description: string;
  /** Verb for the approval control, e.g. "Run it". Host-capped. */
  buttonLabel: string;
  kind: ProposedActionKind;
  /** Absent ⇒ the host's default confirmation copy is sufficient. */
  confirmSeverity?: ProposedActionSeverity;
  /**
   * What the proposal is ABOUT, for hosts that correlate it with other turn
   * output — e.g. suppressing a duplicate run affordance on exactly the
   * created resource this proposal already offers to run. Display/dedup only,
   * never an instruction. Absent on operations with no meaningful target and
   * on servers that predate the field; a host must treat absence as "match
   * unknown" and fall back to its coarser behavior.
   */
  target?: ProposedActionTarget;
}

/**
 * The resource a proposal targets, in the proposing operation's own selector
 * vocabulary: `selector` is whatever the validated input named — an id where
 * the server minted the proposal itself, possibly a name where the model
 * authored it — so hosts should match it against both.
 */
export interface ProposedActionTarget {
  type: string;
  selector: string;
}

/** A resource the turn created, with an app deep link. */
export interface AgentCreatedResource {
  type: string;
  id: string;
  name?: string;
  url: string;
}

/** The completed-turn envelope. */
export interface AgentTurnResponse {
  reply: string;
  toolCalls: Array<{ operation: string }>;
  createdResources: AgentCreatedResource[];
  proposedActions: ProposedAction[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * What an approved action produced, when it produced something a host can
 * link to.
 *
 * Built SERVER-SIDE from the operation registry, never assembled by the host
 * from a result payload: a host that synthesised URLs would have to know each
 * operation's result shape, and would silently link to nothing the moment one
 * changed.
 */
export interface ExecutedActionResource {
  type: string;
  id: string;
  url: string;
}

/** The response to executing an approved action. */
export interface ExecuteProposedActionResponse {
  actionId: string;
  operation: string;
  status: "succeeded";
  kind: ProposedActionKind;
  /** Absent when the action produced nothing linkable (e.g. a cancellation). */
  resource?: ExecutedActionResource;
  /** The raw operation result. Opaque to the contract. */
  result: unknown;
}

/**
 * Connection/timeout error classification, shared across public-API surfaces so
 * they bucket raw runtime failures the same way. Mirrors the Inspector
 * `mapRuntimeError` heuristics.
 */
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /\beconn[a-z]*/i,
  /\bconnection\s+(?:refused|reset|closed|timed?\s*out|aborted|error|failed)\b/i,
  /\b(?:failed|unable)\s+to\s+connect\b/i,
  /\bfetch\s+failed\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bgetaddrinfo\b/i,
];

export function classifyRuntimeError(error: unknown): {
  code: V1ErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }
  if (CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: "SERVER_UNREACHABLE", message };
  }
  return { code: "INTERNAL_ERROR", message };
}
