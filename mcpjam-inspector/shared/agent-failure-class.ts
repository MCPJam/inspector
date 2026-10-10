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
 * failing closed), `platform_capacity` without a user/org scope (MCPJam's
 * budget for everyone), and `invalid_request` / `bad_request`: only Convex
 * sends those, about a request our own engine built.
 *
 * A code that is not listed is an incident whatever its status. A 400 or 401
 * can be ours: a retired pinned model (`model_retired`), or MCPJam's own
 * provider key revoked (`mcpjam_api_error`), fails every turn.
 */
const ROUTINE_CODES: ReadonlySet<string> = new Set([
  // Sign-in.
  "auth_required",
  "unauthorized",
  "session_revoked",
  "oauth_required",
  // Validation.
  "validation_error",
  "guest_input_too_large",
  // Deliberate v1 answers: self-hosted has no v1 agent; an unknown job id.
  "feature_not_supported",
  "not_found",
  // The caller's own quotas and account state. Mirrors the account-state half
  // of the server's `USER_OWNED_DENIAL_CODES` (mcpjam-stream-handler.ts); the
  // other half (`platform_capacity`, `agent_billing_rejected`) is decided
  // above. Guests reach some of these on the customer rail.
  "agent_turn_limit",
  "user_rate_limit",
  "rate_limited",
  "wallet_locked",
  "guest_model_not_allowed",
  "platform_free_budget_exhausted",
  "account_suspended",
  "org_rate_limit",
  "billing_limit_reached",
  "billing_feature_not_included",
  "spend_budget_reached",
  "free_tier_model_restricted",
  // The organization's own AI configuration ("Use your keys for all AI
  // features"): it requires its own provider keys, has no model for the role,
  // the feature has no org-credential adapter (Ask MCPJam is unsupported under
  // the policy), the org's connection is gone, its key was rejected, or its
  // own provider is throttling. The product working on the org's own account.
  // `ai_policy_unavailable` is deliberately NOT here: it is the backend failing
  // closed on its own policy read, which is ours.
  "org_keys_required",
  "org_model_unconfigured",
  "org_runtime_unsupported",
  "ai_scope_unresolved",
  "provider_auth_failed",
  "provider_unavailable",
  "credential_missing",
]);

/** Lane scopes that are one caller at their own share of the budget. */
const ROUTINE_LANE_SCOPES: ReadonlySet<string> = new Set([
  "user",
  "organization",
]);

/** Statuses that are the caller's own state when nothing more is known. */
const ROUTINE_STATUSES_WITHOUT_CODE: ReadonlySet<number> = new Set([
  400, 401, 429,
]);

/**
 * The plan's rule, in one place:
 *
 * routine — a sign-in or validation code; `agent_turn_limit` and the caller's
 * other own quotas; a lane refusal scoped to the user or the organization; a
 * bare 400/401/429 with no code at all (answered in front of the route); and
 * (client-side only) a transport failure while online. Everything else is an
 * incident: any unlisted code whatever its status, a platform-scoped lane
 * refusal, the 503 when the guard failed closed, every
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
  // A code is the better evidence: it decides, and an unlisted one is ours.
  if (code) return ROUTINE_CODES.has(code) ? "routine" : "incident";
  // No code to go on: the status alone. These are answered in front of the
  // route (bearer auth, rate limiters) without a code.
  return facts.httpStatus !== undefined &&
    ROUTINE_STATUSES_WITHOUT_CODE.has(facts.httpStatus)
    ? "routine"
    : "incident";
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
