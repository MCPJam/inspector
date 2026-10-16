export const ErrorCode = {
  GENERATION_FAILED: "GENERATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  // A write rejected because the resource isn't in a state that accepts it
  // (HTTP 409) — the request was well-formed, so VALIDATION_ERROR would
  // misreport it, and retrying it verbatim won't help. Project Environments
  // report stale `expectedRevision`, duplicate live names, and archive-state
  // rejections this way; the more specific ENVIRONMENT_REVISION_CONFLICT below
  // stays for the hosted UI, and collapses onto this code publicly.
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // A billing/entitlement cap was hit (HTTP 402). The structured billing
  // payload (code "billing_limit_reached" / "billing_feature_not_included",
  // limit, allowedValue, plan, resetsAt, …) rides along in the WebRouteError
  // `details` so the client can rebuild a ConvexError and render the proper
  // upgrade message instead of a generic failure.
  BILLING_LIMIT_REACHED: "BILLING_LIMIT_REACHED",
  // A host with the enterprise-managed authorization POLICY connected an
  // `auto` server that has no stored XAA client registration. 409 (config
  // conflict), never a silent downgrade to the discover/OAuth ladder.
  // "Not configured", deliberately NOT "not enrolled": xaaConfigured proves
  // an IdP mode + client id registered at the resource authorization
  // server, not IdP enrollment — XAA_NOT_ENROLLED is reserved for the
  // future issuer-policy evaluator's denied verdicts. NOTE the local route
  // envelope (respondWithLocalRouteError) spreads `details` top-level and
  // drops `code`; clients branch on the top-level `reason:
  // "xaa_connection_not_configured"`, not this code.
  XAA_CONNECTION_NOT_CONFIGURED: "XAA_CONNECTION_NOT_CONFIGURED",
  // A project-environment eval launch resolved one environment revision but
  // the environment changed before `startTestSuiteRun` inserted the run
  // (`expectedEnvironmentRevision` mismatch, backend ENV_REVISION_CONFLICT).
  // 409; interactive callers surface "Environment changed — retry the run",
  // the scheduled worker retries through its trigger/idempotency path.
  ENVIRONMENT_REVISION_CONFLICT: "ENVIRONMENT_REVISION_CONFLICT",
  // A task read/write hit JSON-RPC -32602: the server no longer knows the
  // task. Distinct from a structureless 404 (route missing on an older
  // replica during a mixed-version rollout) and from a transient connect
  // failure, so the client can mark the handle "unavailable" instead of
  // retrying forever or dropping it.
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  // A tasks request the resolved wire cannot serve: no tasks wire at all, a
  // method that does not exist on that wire (`tasks/result` on the extension),
  // or an undeclared capability. A caller/feature error (400), never a 500.
  TASKS_UNSUPPORTED: "TASKS_UNSUPPORTED",
  // A scenario-scoped turn was refused by the backend when the route
  // re-resolved the authoritative runtime config (403). Deliberately
  // collapses "no such scenario" and "no grant for this caller" into one
  // code — the anti-probing collapse the backend already performs — so the
  // browser learns "you cannot run this turn" without learning whether the
  // scenario exists. Distinct from INTERNAL_ERROR so the client can attempt a
  // re-redeem instead of dead-ending on a generic failure banner.
  SCENARIO_ACCESS_DENIED: "SCENARIO_ACCESS_DENIED",
  // The caller's cached `accessVersion` is behind the scenario's current one
  // (409): a rebind, mode change, or republish moved the authoritative
  // config out from under an open tab. Recoverable — re-redeem the share
  // token and replay the turn. Emitted once the backend enforces the
  // version it already advertises.
  SCENARIO_ACCESS_STALE: "SCENARIO_ACCESS_STALE",
  // The USER'S MCP server refused the credentials MCPJam presented. Their
  // failure, not ours — it was the single largest error class on
  // `/api/web/tools/list` (3,706 events in 30 days) and every one of them
  // logged as INTERNAL_ERROR, spending the 5xx budget and hiding real internal
  // faults behind them.
  //
  // Served at 403, deliberately NOT 401. `authFetch` retries any 401 from an
  // `/api/web/*` path when the actor has no WorkOS session
  // (`shouldRetryApiAuth401`: `!isAuthenticated && !hasSession`) by clearing
  // the bearer cache, force-refreshing the guest session and replaying the
  // request; the hosted `webError` envelope has no way to set the
  // `X-MCP-Auth-Required: oauth` header that suppresses it (only the LOCAL
  // `respondWithLocalRouteError` does). Mapping thousands of upstream auth
  // rejections onto 401 would therefore make every guest burn a guest-token
  // refresh and a replay on a failure the replay cannot fix. 403 is also the
  // honest HTTP answer: the CALLER's credentials are not the problem, so
  // re-authenticating with MCPJam will not change the outcome — the user has
  // to reconnect the upstream server.
  UPSTREAM_AUTH_FAILED: "UPSTREAM_AUTH_FAILED",
  // The caller's AuthKit session has been revoked (signed out, or ended by the
  // identity provider) — 401, and signing in again is the only remedy (MJ-011).
  // Publicly it collapses onto UNAUTHORIZED with `details.reason:
  // "SESSION_REVOKED"`, the v1 convention for a specific 401; the mapping sits
  // in `routes/v1/envelope.ts` beside UPSTREAM_AUTH_FAILED's.
  SESSION_REVOKED: "SESSION_REVOKED",
  // A chat continuation refused before any model call (409): the user
  // message's step budget is spent, or the model keeps sending the same tool
  // call with input that cannot run. The browser stops resuming on it and the
  // user continues by sending a message. See `utils/agent-loop-guard.ts`.
  AGENT_STEP_LIMIT: "AGENT_STEP_LIMIT",
  // The USER'S MCP server answered with an HTTP error status (a 404 for a
  // wrong endpoint path, a 405, its own 500). Served at 424 by
  // `mapTargetServerError`. Not SERVER_UNREACHABLE: the chat client words that
  // code as "Couldn't reach X. It may be offline", which is wrong for a server
  // that answered; an unrecognized code falls through to the message, which
  // names the status.
  UPSTREAM_HTTP_ERROR: "UPSTREAM_HTTP_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

