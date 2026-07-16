/**
 * Wire types for hosted-mode MCP elicitation.
 *
 * Elicitation is a nested server→client request that arrives in the middle of
 * a `tools/call`. In hosted mode the turn's MCP connection, the blocking tool
 * call, and the HTTP stream to the browser all live on ONE replica, so the
 * REQUEST rides this turn's UI message stream as a transient data part (the
 * same delivery `data-trace-event` / `data-rpc-log` use). Only the user's
 * ANSWER has to cross replicas — it rendezvouses through Convex, keyed by
 * `rendezvousId`.
 *
 * Delivery is therefore scoped to the requesting turn's own stream by
 * construction: there is no broadcast surface and no cross-tenant fan-out.
 *
 * These parts are `transient: true` at the write site — they reach the AI SDK
 * `onData` callback but never enter `message.parts`, because an elicitation is
 * turn-scoped UI, not conversation history.
 */

/** Elicitation mode per MCP 2025-11-25. Absent on the wire ⇒ `"form"`. */
export type HostedElicitationMode = "form" | "url";

export type HostedElicitationAction = "accept" | "decline" | "cancel";

/** Terminal outcomes the server reports back to the browser. */
export type HostedElicitationOutcome = "answered" | "expired" | "cancelled";

/**
 * A server is asking the user for input, and the tool call is blocked on the
 * answer.
 *
 * `rendezvousId` is minted by the replica (`crypto.randomUUID`) and is the key
 * the browser answers on. It is deliberately NOT the server-chosen
 * `elicitationId` (URL mode), which is untrusted and must never be used as an
 * unguessable key.
 */
export interface HostedElicitationRequestEvent {
  kind: "request";
  rendezvousId: string;
  /**
   * The MCP server that issued the request. `serverId` is the trusted,
   * immutable anchor; `serverName` is a display label only. Clients MUST make
   * it clear which server is asking (MCP 2025-11-25 elicitation §Security).
   */
  serverId: string;
  serverName?: string;
  mode: HostedElicitationMode;
  message: string;
  /** Form mode: the MCP `requestedSchema` (flat-object subset). */
  requestedSchema?: unknown;
  /** URL mode: the URL the user is asked to open. Never pre-fetched. */
  url?: string;
  /** URL mode: server-chosen correlation id. Untrusted; display/correlation only. */
  serverElicitationId?: string;
  /** Epoch ms after which the server resolves this as `cancel`. */
  expiresAt: number;
  chatSessionId?: string;
}

/**
 * The request reached a terminal state server-side. Sent so an open dialog
 * closes even when the browser was not the thing that resolved it (TTL expiry,
 * or an answer submitted from elsewhere).
 */
export interface HostedElicitationResolvedEvent {
  kind: "resolved";
  rendezvousId: string;
  outcome: HostedElicitationOutcome;
  action?: HostedElicitationAction;
}

/**
 * A `tools/call` failed with `-32042 URLElicitationRequiredError`: the server
 * needs an out-of-band interaction completed before it can serve the request.
 *
 * Display-only — there is NO rendezvous row and no JSON-RPC response owed,
 * because the call already failed. The user opens the URL out of band and the
 * tool is retried (by the model, or manually).
 */
export interface HostedElicitationUrlRequiredEvent {
  kind: "url_required";
  serverId: string;
  serverName?: string;
  /** The tool call that failed, so the UI can anchor the notice to it. */
  toolCallId?: string;
  elicitations: Array<{
    url: string;
    elicitationId: string;
    message?: string;
  }>;
}

export type HostedElicitationEvent =
  | HostedElicitationRequestEvent
  | HostedElicitationResolvedEvent
  | HostedElicitationUrlRequiredEvent;

/** Wire literal for the stream data part carrying a `HostedElicitationEvent`. */
export const HOSTED_ELICITATION_DATA_PART_TYPE = "data-elicitation" as const;

export interface HostedElicitationDataPart {
  type: typeof HOSTED_ELICITATION_DATA_PART_TYPE;
  data: HostedElicitationEvent;
}

/**
 * The answer the browser submits to Convex. `rendezvousId` scopes it; the
 * backend re-derives ownership from the caller's identity and enforces a
 * one-shot transition, so this payload is not trusted for authorization.
 */
export interface HostedElicitationAnswer {
  rendezvousId: string;
  action: HostedElicitationAction;
  /** Form-mode accepts only. Values are constrained to MCP's ElicitResult shape. */
  content?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional string: absent is fine, present-but-wrong-type is not. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isAction(value: unknown): value is HostedElicitationAction {
  return value === "accept" || value === "decline" || value === "cancel";
}

/**
 * Validates a `data-elicitation` payload before consumers treat it as typed.
 *
 * Strict about optional fields, not just required ones: this guard is what
 * stands between a malformed part and UI that dereferences it. A `url`-mode
 * request without a `url` would render a consent dialog with nothing to
 * consent to, and an unconstrained `action` would be forwarded to the backend
 * as an answer it must then reject.
 */
export function isHostedElicitationEvent(
  value: unknown,
): value is HostedElicitationEvent {
  if (!isRecord(value)) return false;

  if (value.kind === "request") {
    if (
      typeof value.rendezvousId !== "string" ||
      typeof value.serverId !== "string" ||
      typeof value.message !== "string" ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      !isOptionalString(value.serverName) ||
      !isOptionalString(value.serverElicitationId) ||
      !isOptionalString(value.chatSessionId)
    ) {
      return false;
    }
    // Mode-specific payload: each mode's dialog is useless without its field.
    if (value.mode === "url") return typeof value.url === "string";
    if (value.mode === "form") return true;
    return false;
  }

  if (value.kind === "resolved") {
    return (
      typeof value.rendezvousId === "string" &&
      (value.outcome === "answered" ||
        value.outcome === "expired" ||
        value.outcome === "cancelled") &&
      (value.action === undefined || isAction(value.action))
    );
  }

  if (value.kind === "url_required") {
    return (
      typeof value.serverId === "string" &&
      isOptionalString(value.serverName) &&
      isOptionalString(value.toolCallId) &&
      Array.isArray(value.elicitations) &&
      value.elicitations.length > 0 &&
      value.elicitations.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.url === "string" &&
          typeof entry.elicitationId === "string" &&
          isOptionalString(entry.message),
      )
    );
  }

  return false;
}

export function isHostedElicitationDataPart(
  value: unknown,
): value is HostedElicitationDataPart {
  if (!isRecord(value)) return false;
  return (
    value.type === HOSTED_ELICITATION_DATA_PART_TYPE &&
    isHostedElicitationEvent(value.data)
  );
}
