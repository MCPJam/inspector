/**
 * Shared analytics event registry.
 *
 * Every product analytics event name lives here, typed, with its
 * authoritative capture source. Client code sends events through
 * `client/src/lib/analytics.ts#track`, which only accepts names from this
 * registry; server code sends through `server/utils/analytics.ts` the same
 * way. Free-string `posthog.capture("...")` calls are frozen by the ratchet
 * test in `client/src/lib/__tests__/analytics-ratchet.test.ts` — new call
 * sites must register here and use `track()`.
 *
 * `source` marks the ONE authoritative capture point for the event:
 *  - "client": fired from the browser (reaches PostHog via the /relay proxy)
 *  - "server": fired from the Hono server / backend (cannot be ad-blocked)
 *
 * Server twins: while a client event migrates to server-side capture, the
 * server fires `<name>_server` in parallel. The client/server pair ratio per
 * platform IS the live ad-block rate (see the block-rate dashboard). After
 * the parallel-run window, the server event takes the canonical name and the
 * client twin is deleted.
 *
 * Events are migrated into this registry incrementally, area by area — the
 * ratchet test keeps unmigrated legacy call sites frozen at their current
 * files in the meantime.
 */

export const ANALYTICS_EVENTS = {
  // --- Chat (paired: client event + server twin) ---
  send_message: { source: "client" },
  send_message_server: { source: "server" },

  // --- Tool execution (paired) ---
  execute_tool: { source: "client" },
  execute_tool_server: { source: "server" },

  // --- Eval runs (paired) ---
  eval_suite_run_started: { source: "client" },
  eval_suite_run_started_server: { source: "server" },

  // --- Skills (exemplar migrated area) ---
  skill_deleted: { source: "client" },
  skill_promoted: { source: "client" },
  skill_viewed: { source: "client" },
  skill_uploaded: { source: "client" },
  skill_injected: { source: "client" },
  skill_loaded: { source: "client" },
} as const satisfies Record<string, { source: "client" | "server" }>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;
