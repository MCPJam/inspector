/**
 * How platform analysis reached a model, or why it did not run.
 *
 * The organization AI key policy ("Use your keys for all AI features") added a
 * value to each of these unions. They live here as named types because
 * `types.ts` is past the file budget; `types.ts` re-exports them.
 */

/**
 * How an analyzer reaches its model. `gateway_preferred` uses the Gateway when
 * it is configured and priced there, else OpenRouter. `typed_decision` uses a
 * typed classifier through the Gateway, with a fallback model only when the
 * classifier cannot be reached. `org_keys` means the organization requires its
 * own provider keys, so the analyzer runs on its own provider connection.
 */
export type PlatformAnalysisRouting =
  "gateway_preferred" | "typed_decision" | "org_keys";

/**
 * A findings job's state. `skipped` means an automatic analysis was not
 * started, and the job's `errorCode` says why (for example, the organization
 * requires its own provider keys and analysis can't run on its providers yet).
 */
export type PlatformFindingsJobStatus =
  "pending" | "completed" | "failed" | "skipped";

/**
 * Why the readiness observation pass stands where it does. See
 * `PlatformReadinessObservationState` for `billing_limit_reached` and
 * `platform_cap_reached`.
 *
 * `ai_unavailable` means the organization requires its own provider keys and
 * has no compatible provider for the observation pass, so no model ran. It is
 * not an outage and needs no top-up. An admin fixes it by changing the
 * organization's AI configuration.
 */
export type PlatformReadinessObservationReason =
  | "not_requested"
  | "billing_limit_reached"
  | "platform_cap_reached"
  | "ai_unavailable"
  | "provider_error"
  | "provider_timeout"
  | "schema_invalid"
  | "no_evidence"
  | "cancelled";
