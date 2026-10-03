/**
 * Ask MCPJam's failure classes, shared by the server and the browser so both
 * sides of a failure classify it identically.
 *
 * Every Ask MCPJam failure reaches Sentry tagged `surface: mcpjam_agent` and a
 * `page_class`:
 *
 * - `incident` pings #mcpjam-alerts immediately;
 * - `routine` pings only on a spike — an expired sign-in, a validation error,
 *   a user's or org's OWN quota, or a client's own network failing.
 *
 * The server's capture policy is `server/utils/agent-failure-capture.ts`; the
 * browser's is the agent mode of `client/src/lib/chat-error-reporting.ts`.
 */

export const AGENT_SURFACE = "mcpjam_agent";

export type PageClass = "incident" | "routine";

/** What a capture point knows about one failure. Every field is optional. */
export type FailureFacts = {
  /** Stable catch-site id; part of the fingerprint. */
  source: string;
  /** The status the failure answered (or was answered) with. */
  httpStatus?: number;
  /** The envelope's `code` (`agent_turn_limit`, `platform_capacity`, …). */
  code?: string;
  /** `agent_billing_rejected`'s `reason`. */
  reason?: string;
  /** `agent_turn_limit`'s `gatedBy`. */
  gatedBy?: string;
  /** Whose lane refused a `platform_capacity`: user, organization, platform. */
  scope?: string;
  /** The MCP server a failure names, so each docs server groups apart. */
  serverId?: string;
  /** Forces the level; otherwise routine → warning, incident → error. */
  level?: "error" | "warning";
  /** Forces the class, for a site whose rule is not status-shaped. */
  pageClass?: PageClass;
};

/** A surface's capture rule, as the engine and the routes consume it. */
/**
 * Codes that are the product working on the caller's own account: sign-in,
 * request validation, and the caller's own quotas. Lower-cased; the backend
 * and this server spell some of them in capitals.
 *
 * Deliberately NOT here: `agent_billing_rejected` (every reason, including
 * `credential_not_allowed` — our own client sending a credential the backend
 * will not take is our bug), `platform_generation_unavailable` (the lane guard
 * failing closed), and `platform_capacity` without a user/org scope (MCPJam's
 * budget for everyone).
 */
const ROUTINE_CODES: ReadonlySet<string> = new Set([
  // Sign-in.
  "auth_required",
  "unauthorized",
  "session_revoked",
  // Validation.
  "validation_error",
  "invalid_request",
  "bad_request",
  "guest_input_too_large",
  // The caller's own quotas and account state.
  "agent_turn_limit",
  "user_rate_limit",
  "rate_limited",
  "wallet_locked",
  "guest_model_not_allowed",
]);

/** Lane scopes that are one caller at their own share of the budget. */
const ROUTINE_LANE_SCOPES: ReadonlySet<string> = new Set([
  "user",
  "organization",
]);

/**
 * The plan's rule, in one place:
 *
 * routine — a 401; a 400 validation error; `agent_turn_limit`; a lane refusal
 * scoped to the user or the organization; and (client-side only) a transport
 * failure while online. Everything else is an incident: a platform-scoped
 * lane refusal, the 503 when the guard failed closed, every
 * `agent_billing_rejected` reason, 5xx and throws, and malformed or empty
 * streams.
 */
export function agentPageClass(facts: FailureFacts): PageClass {
  if (facts.pageClass) return facts.pageClass;
  const code = facts.code?.toLowerCase();
  if (code === "platform_capacity") {
    return facts.scope && ROUTINE_LANE_SCOPES.has(facts.scope)
      ? "routine"
      : "incident";
  }
  if (code === "agent_billing_rejected") return "incident";
  if (code && ROUTINE_CODES.has(code)) return "routine";
  if (facts.httpStatus === 401 || facts.httpStatus === 400) return "routine";
  return "incident";
}

/** One issue per distinct failure shape, not per stack or per message. */
export function agentFingerprint(facts: FailureFacts): string[] {
  return [
    AGENT_SURFACE,
    facts.source,
    facts.code ??
      (facts.httpStatus !== undefined ? `http_${facts.httpStatus}` : "throw"),
    ...(facts.reason ? [`reason:${facts.reason}`] : []),
    ...(facts.gatedBy ? [`gatedBy:${facts.gatedBy}`] : []),
    ...(facts.scope ? [`scope:${facts.scope}`] : []),
    ...(facts.serverId ? [`server:${facts.serverId}`] : []),
  ];
}
