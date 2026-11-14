import type { Harness } from "@mcpjam/sdk/host-config/internal";

/**
 * The fields of `harness_turn_completed`, the one analytics event a harness
 * turn sends when its response closes (`server/utils/harness/harness-turn-event.ts`
 * builds it).
 *
 * Closed vocabularies and whole milliseconds only. The strict server analytics
 * boundary (`strict-server-analytics.ts`) reads these lists, forwards their
 * values and drops anything else.
 */

/** The route that ran the turn, or `local` for one on the person's machine. */
export const HARNESS_TURN_SURFACES = ["web", "api", "local"] as const;

/** `first` while the conversation's lane has no committed state. */
export const HARNESS_TURN_KINDS = ["first", "follow_up"] as const;

/**
 * How the session started: re-attached to the bridge an earlier turn left
 * running, or adopted the local runtime an earlier turn kept (`warm`);
 * resumed from saved files (`disk_resume`), started fresh (`new`), or
 * continued a turn paused on an approval (`approval_continuation`).
 */
export const HARNESS_TURN_STARTS = [
  "warm",
  "disk_resume",
  "new",
  "approval_continuation",
] as const;

/**
 * Why a reuse was refused, or `none`. The lane's runtime fingerprint changed,
 * or a kept local runtime was started with another configuration than the
 * turn's (`configuration_changed`); the saved session belongs to another box
 * or runtime (`sandbox_replaced`); resuming from saved files failed
 * (`resume_failed`); or a warm attach fell back to saved files because the
 * box's probe refused the bridge (`probe_refused`: its process, birth,
 * configuration, token or expiry), the attach threw (`attach_failed`), or it
 * ran out of time (`attach_timeout`).
 *
 * A local turn that did not adopt the runtime its conversation's last turn
 * kept, and started another, says why, in the words that end the kept one:
 * it is not the runtime the lane's committed state names, or not this
 * person's (`superseded`); it reached its lifetime (`lifetime`); its process
 * had stopped (`process_died`); its pack is no longer the one a turn would
 * select, or an install is in flight (`runtime_update`); the checks a turn
 * re-runs no longer allow it (`authorization_revoked`); or a new model lease
 * could not be bound to it (`renewal_failed`).
 */
export const HARNESS_TURN_FALLBACK_REASONS = [
  "none",
  "configuration_changed",
  "sandbox_replaced",
  "resume_failed",
  "probe_refused",
  "attach_failed",
  "attach_timeout",
  "superseded",
  "lifetime",
  "process_died",
  "runtime_update",
  "authorization_revoked",
  "renewal_failed",
] as const;

/**
 * What the framework's bootstrap did on the box (`harness-bake-observer.ts`).
 * `unknown` when none was observed: a local turn, or one that never reached
 * its box.
 */
export const HARNESS_TURN_BOOTSTRAPS = [
  "baked",
  "installed",
  "install_failed",
  "reused",
  "unknown",
] as const;

export const HARNESS_TURN_OUTCOMES = [
  "completed",
  "failed",
  "aborted",
] as const;

/**
 * Whole milliseconds. `first_text_ms` counts from the start of the request,
 * and the stages are the `[harness][timing]` line's, except that
 * `box_wake_ms` also counts the route creating or waking the conversation's
 * box before the turn began: it is the line's `boxWake` plus its
 * `boxAcquisitionMs`. A stage the turn never finished is absent. A local
 * turn has no box or broker, so it reports that window as
 * `local_prepare_ms` instead of `box_wake_ms` and `broker_start_ms`.
 */
export const HARNESS_TURN_DURATIONS = [
  "first_text_ms",
  "claim_ms",
  "box_wake_ms",
  "broker_start_ms",
  "local_prepare_ms",
  "session_connect_ms",
  "dispatch_setup_ms",
  "model_stream_ms",
] as const;

export type HarnessTurnSurface = (typeof HARNESS_TURN_SURFACES)[number];
export type HarnessTurnKind = (typeof HARNESS_TURN_KINDS)[number];
export type HarnessTurnStart = (typeof HARNESS_TURN_STARTS)[number];
export type HarnessTurnFallbackReason =
  (typeof HARNESS_TURN_FALLBACK_REASONS)[number];
export type HarnessTurnBootstrap = (typeof HARNESS_TURN_BOOTSTRAPS)[number];
export type HarnessTurnOutcome = (typeof HARNESS_TURN_OUTCOMES)[number];
export type HarnessTurnDuration = (typeof HARNESS_TURN_DURATIONS)[number];

/**
 * `kind` once the lane is claimed; `start` and `fallback_reason` once a
 * session starts. A turn that fails before its session still sends the
 * `fallback_reason` of a reuse it refused.
 */
export type HarnessTurnEventProperties = {
  surface: HarnessTurnSurface;
  harness_id: Harness;
  outcome: HarnessTurnOutcome;
  bootstrap: HarnessTurnBootstrap;
  kind?: HarnessTurnKind;
  start?: HarnessTurnStart;
  fallback_reason?: HarnessTurnFallbackReason;
} & Partial<Record<HarnessTurnDuration, number>>;
