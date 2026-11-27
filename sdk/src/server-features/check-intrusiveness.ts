/**
 * How intrusive each conformance check is, for every check id of every suite.
 *
 * The server canvas runs some checks in the background after connect, with no
 * one asking. Only `passive` and `read-only` checks may run that way; the rest
 * run when a person starts a conformance run. The levels are the directory
 * readiness ones:
 *
 *   passive         sends nothing of its own; grades what other requests
 *                   already returned.
 *   read-only       sends only requests a connected client sends anyway
 *                   (handshake, discover, list methods, metadata GETs) or
 *                   grades resource reads a background run sends itself in a
 *                   way that cannot ask the user for input (see below).
 *   side-effecting  may change server state, ask the user for input, or send
 *                   a request the spec does not promise is harmless: tool
 *                   calls, task creation, subscriptions and streams, webhook
 *                   registration, OAuth flows and client registration,
 *                   completion, log level changes, reads of arbitrary
 *                   resources, and the raw transport and header checks
 *                   (malformed or mismatched headers, forged hosts, extra
 *                   sessions, DELETE).
 *
 * Resource reads. The Apps read checks grade reads a background run sends
 * itself: the `ui://` resources the server's own tools name, read straight on
 * the connection's client with the response cache bypassed, never through the
 * manager's multi-round-trip loop. A read answered with `input_required` or
 * failed with a URL-elicitation error is abandoned, and a 2025-era
 * `elicitation/create` never reaches the user, so those checks are passive or
 * read-only. A read only a conformance run sends, such as the cache-hint
 * checks' read of the first listed resource, goes through the conformance
 * harness and stays side-effecting.
 *
 * Each record is exhaustive over its suite's check-id union, so a new check
 * fails typecheck until someone decides its level. The Tasks tool checks and
 * the Events webhook checks are pinned to `side-effecting` by type.
 *
 * Browser-safe: type imports only.
 */

import type { DirectoryIntrusiveness } from "../directory-readiness/types.js";
import type { MCPCheckId } from "../mcp-conformance/types.js";
import type { MCPAppsCheckId } from "../apps-conformance/types.js";
import type {
  MCPTasksCheckId,
  MCPTasksToolCheckId,
} from "../tasks-conformance/types.js";
import type {
  EventsCheckId,
  EventsWebhookCheckId,
} from "../events-conformance/types.js";
import type { OAuthConformanceCheckId } from "../oauth-conformance/types.js";
import type { ConformanceCheckRef, ConformanceSuiteKey } from "./types.js";

type TasksIntrusiveness = {
  readonly [K in MCPTasksCheckId]: K extends MCPTasksToolCheckId
    ? "side-effecting"
    : DirectoryIntrusiveness;
};

type EventsIntrusiveness = {
  readonly [K in EventsCheckId]: K extends EventsWebhookCheckId
    ? "side-effecting"
    : DirectoryIntrusiveness;
};

/** Protocol suite. */
export const PROTOCOL_CHECK_INTRUSIVENESS = {
  "server-initialize": "read-only",
  ping: "read-only",
  // Changes the session's log level on the server.
  "logging-set-level": "side-effecting",
  // The spec does not promise completion/complete is free of side effects.
  "completion-complete": "side-effecting",
  "capabilities-consistent": "read-only",
  "tools-list": "read-only",
  "tools-input-schemas-valid": "read-only",
  "tools-x-mcp-header-declarations-valid": "passive",
  "prompts-list": "read-only",
  "resources-list": "read-only",
  // On the legacy era it sends its own initialize first, which opens a session
  // it never closes.
  "protocol-invalid-method-error": "side-effecting",
  // Sends initialize with a forged Host and Origin.
  "localhost-host-rebinding-rejected": "side-effecting",
  // Sends its own initialize, finishes the handshake and ends the session
  // with DELETE.
  "localhost-host-valid-accepted": "side-effecting",
  // The raw transport family opens its own sessions and concurrent streams
  // and ends them with DELETE.
  "server-sse-polling-session": "side-effecting",
  "server-sse-streams-functional": "side-effecting",
  "notification-post-accepted": "side-effecting",
  "get-stream-or-405": "side-effecting",
  "session-id-visible-ascii": "side-effecting",
  "post-response-content-type": "side-effecting",
  "modern-client-handshake": "read-only",
  "modern-server-discover": "read-only",
  "modern-result-type-present": "read-only",
  "modern-cacheable-result-hints": "read-only",
  // These two read the first listed resource, whatever it is, through the
  // conformance harness; no background run sends that read.
  "modern-cache-hint-coverage": "side-effecting",
  "modern-cache-hint-values-valid": "side-effecting",
  "modern-cache-scope-stable-across-pages": "read-only",
  // Header and envelope checks send deliberately malformed requests.
  "modern-protocol-version-header-mismatch": "side-effecting",
  "modern-method-header-mismatch": "side-effecting",
  "modern-name-header-mismatch": "side-effecting",
  "modern-unsupported-version-error": "side-effecting",
  "modern-missing-method-header-rejected": "side-effecting",
  "modern-header-names-case-insensitive": "side-effecting",
  // Calls the tool the user names for it.
  "modern-undeclared-capability-error": "side-effecting",
  "modern-no-session-id": "read-only",
  // Sends resources/subscribe and logging/setLevel, among others.
  "modern-removed-methods-not-found": "side-effecting",
  "modern-resource-not-found-invalid-params": "read-only",
  "modern-resource-read-no-empty-contents": "read-only",
  // Both call tools.
  "modern-tool-output-schema-conformant": "side-effecting",
  "modern-logs-require-log-level": "side-effecting",
  // Open a subscriptions/listen stream.
  "modern-subscription-ack-precedes-notifications": "side-effecting",
  "modern-subscription-filter-and-tagging": "side-effecting",
  "modern-subscription-graceful-close": "side-effecting",
  "wire-schema-valid": "passive",
} as const satisfies Record<MCPCheckId, DirectoryIntrusiveness>;

/** MCP Apps suite: lists, reads of `ui://` resources, and grading. */
export const APPS_CHECK_INTRUSIVENESS = {
  "ui-tools-present": "read-only",
  "ui-tool-metadata-valid": "passive",
  "ui-tool-input-schema-valid": "passive",
  "ui-listed-resources-valid": "read-only",
  // The read checks grade the `ui://` reads a background run sends itself and
  // abandons when the server asks for input (see the header).
  "ui-resources-readable": "read-only",
  "ui-resource-contents-valid": "passive",
  "ui-resource-meta-valid": "passive",
} as const satisfies Record<MCPAppsCheckId, DirectoryIntrusiveness>;

/** Tasks suite. Every check that calls a tool or creates a task is side-effecting by type. */
export const TASKS_CHECK_INTRUSIVENESS = {
  "tasks-result-type-discipline": "side-effecting",
  "tasks-undeclared-creation-refused": "side-effecting",
  "tasks-undeclared-capability-rejected": "side-effecting",
  "tasks-ttl-shape": "side-effecting",
  "tasks-inline-result": "side-effecting",
  "tasks-mcp-name-routing": "side-effecting",
  // Sends tasks/update and tasks/cancel for an unknown id as well.
  "tasks-invalid-task-id-rejected": "side-effecting",
  "tasks-status-payload-shape": "side-effecting",
  "tasks-cancel-ack-shape": "side-effecting",
  "tasks-update-ack-shape": "side-effecting",
  "tasks-ttl-integer-shape": "side-effecting",
  "tasks-undeclared-capability-names-requirements": "side-effecting",
} as const satisfies TasksIntrusiveness;

/** Events suite. Every webhook check is side-effecting by type. */
export const EVENTS_CHECK_INTRUSIVENESS = {
  "events-capability-declared": "passive",
  "events-list-shape": "read-only",
  // Needs event arguments the user supplies, and polling can start
  // server-side state for the cursor.
  "events-poll-null-cursor": "side-effecting",
  "events-subscribe-rejects-http-callback": "side-effecting",
  "events-subscribe-rejects-invalid-secret": "side-effecting",
  "events-subscribe-result-shape": "side-effecting",
  "events-subscribe-idempotent": "side-effecting",
  "events-granted-lifetime": "side-effecting",
  "events-no-expiry-only-when-requested": "side-effecting",
  "events-receiver-consent": "side-effecting",
  "events-consent-failure-blocks-delivery": "side-effecting",
  "events-no-redirect-follow": "side-effecting",
  "events-private-callback-rejected": "side-effecting",
  "events-delivery-signature": "side-effecting",
  "events-webhook-id-equals-event-id": "side-effecting",
  "events-webhook-message-id": "side-effecting",
  "events-subscription-id-header": "side-effecting",
  "events-delivery-content-type": "side-effecting",
  "events-delivery-body-size": "side-effecting",
  "events-unsubscribe-twice": "side-effecting",
  // Opens a push stream.
  "events-push-heartbeat": "side-effecting",
  "chatgpt-readiness-webhook-listed": "passive",
  "chatgpt-readiness-protocol-version": "passive",
  "chatgpt-readiness-transport": "passive",
} as const satisfies EventsIntrusiveness;

/**
 * OAuth suite. The suite runs a full OAuth flow, so everything after it is
 * side-effecting. The two challenge checks send an unauthenticated request
 * and read published metadata, as the background authorization probe does.
 */
export const OAUTH_CHECK_INTRUSIVENESS = {
  verify_profile_shape: "side-effecting",
  verify_profile_stable: "side-effecting",
  verify_profile_id_opaque: "side-effecting",
  verify_profile_identity_stable_across_flows: "side-effecting",
  verify_profile_stable_after_refresh: "side-effecting",
  oauth_dcr_http_redirect_uri: "side-effecting",
  oauth_invalid_client: "side-effecting",
  oauth_invalid_authorize_redirect: "side-effecting",
  oauth_invalid_token: "side-effecting",
  oauth_invalid_redirect: "side-effecting",
  oauth_token_format: "side-effecting",
  oauth_unauthenticated_challenge: "read-only",
  oauth_resource_metadata_challenge: "read-only",
  // Sends a made-up Mcp-Session-Id.
  oauth_stale_session_rejection: "side-effecting",
} as const satisfies Record<OAuthConformanceCheckId, DirectoryIntrusiveness>;

export const CHECK_INTRUSIVENESS: Readonly<
  Record<ConformanceSuiteKey, Readonly<Record<string, DirectoryIntrusiveness>>>
> = {
  protocol: PROTOCOL_CHECK_INTRUSIVENESS,
  apps: APPS_CHECK_INTRUSIVENESS,
  tasks: TASKS_CHECK_INTRUSIVENESS,
  events: EVENTS_CHECK_INTRUSIVENESS,
  oauth: OAUTH_CHECK_INTRUSIVENESS,
};

/** A check's level, or `undefined` for a ref this build does not know. */
export function checkIntrusiveness(
  ref: ConformanceCheckRef,
): DirectoryIntrusiveness | undefined {
  const separator = ref.indexOf(":");
  const suite = ref.slice(0, separator);
  const checkId = ref.slice(separator + 1);
  if (!Object.hasOwn(CHECK_INTRUSIVENESS, suite)) return undefined;
  const levels = CHECK_INTRUSIVENESS[suite as ConformanceSuiteKey];
  return Object.hasOwn(levels, checkId) ? levels[checkId] : undefined;
}

/**
 * Whether a check may run, or have its result recorded, without a person
 * starting it. Unknown refs are refused.
 */
export function isBackgroundSafeCheck(ref: ConformanceCheckRef): boolean {
  const level = checkIntrusiveness(ref);
  return level === "passive" || level === "read-only";
}

export class BackgroundCheckRefusedError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(
      `Check ${ref} is not passive or read-only, so it runs only when a person starts a conformance run.`,
    );
    this.name = "BackgroundCheckRefusedError";
    this.ref = ref;
  }
}

/** Throws unless {@link isBackgroundSafeCheck}. */
export function assertBackgroundSafeCheck(ref: ConformanceCheckRef): void {
  if (!isBackgroundSafeCheck(ref)) throw new BackgroundCheckRefusedError(ref);
}
