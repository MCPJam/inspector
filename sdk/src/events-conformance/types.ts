/**
 * MCP Events conformance — profile-aware, MUST vs SHOULD.
 *
 * Every result names its PROFILE (`draft@28ec35e` or `chatgpt@2026-09-30`),
 * each check's STRENGTH (a MUST violation fails the run, a SHOULD violation
 * only warns), and the protocol pin the run used. Checks that would fail
 * behaviour the draft ALLOWS are written to pass the allowed alternatives:
 * consent by any of the four methods, a second unsubscribe answering either
 * `{}` or NotFound, a grant clamped UP to a server minimum.
 */

import type { ConformanceRunOutcome, ConformanceSkipReason } from "../conformance-outcome.js";
import type { EventsProfileId } from "../events/profiles.js";

export const EVENTS_CHECK_IDS = [
  "events-capability-declared",
  "events-list-shape",
  "events-poll-null-cursor",
  "events-subscribe-rejects-http-callback",
  "events-subscribe-rejects-invalid-secret",
  "events-subscribe-result-shape",
  "events-subscribe-idempotent",
  "events-granted-lifetime",
  "events-no-expiry-only-when-requested",
  "events-receiver-consent",
  "events-consent-failure-blocks-delivery",
  "events-no-redirect-follow",
  "events-private-callback-rejected",
  "events-delivery-signature",
  "events-webhook-id-equals-event-id",
  "events-subscription-id-header",
  "events-delivery-content-type",
  "events-delivery-body-size",
  "events-unsubscribe-twice",
  "events-push-heartbeat",
  "chatgpt-readiness-webhook-listed",
  "chatgpt-readiness-protocol-version",
] as const;

export type EventsCheckId = (typeof EVENTS_CHECK_IDS)[number];

export type EventsCheckStrength = "MUST" | "SHOULD";

/**
 * `warned` is a SHOULD violation: reported, never a failure. A MUST
 * violation is `failed`.
 */
export type EventsCheckStatus = "passed" | "failed" | "warned" | "skipped";

export interface EventsCheckResult {
  id: EventsCheckId;
  title: string;
  strength: EventsCheckStrength;
  status: EventsCheckStatus;
  skipReason?: ConformanceSkipReason;
  /** What was observed, or why it could not run. Never contains secrets. */
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface EventsConformanceResult {
  profile: EventsProfileId;
  /** The negotiated protocol version the checks ran on. */
  protocolVersion?: string;
  outcome: ConformanceRunOutcome;
  /** True only when `outcome` is `"passed"` and no override was in effect. */
  passed: boolean;
  /**
   * Labelled development overrides in effect. Any override makes the run
   * non-conformant by construction: `passed` is false and the outcome is at
   * best `incomplete`.
   */
  overrides: Array<"insecure-local-receiver">;
  checks: EventsCheckResult[];
  summary: { passed: number; failed: number; warned: number; skipped: number };
  target: string;
  durationMs: number;
}
