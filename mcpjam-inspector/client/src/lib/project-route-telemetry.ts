/**
 * Rollout observability for canonical project URLs.
 *
 * Deliberately tiny and deliberately low-cardinality: no project ids, no
 * organization ids, no pathnames. What these answer is whether the migration
 * is safe to finish — how much legacy traffic is still arriving, how long a
 * scoped URL takes to resolve, how often one is refused, and whether a
 * redirect guard is tripping — not who did it.
 */
import { track } from "./analytics";

const LOCATION = "project-route";

export type LegacyNormalizationSource = "unscoped" | "query";

export function trackLegacyProjectNormalization(args: {
  source: LegacyNormalizationSource;
  resolved: boolean;
}): void {
  track("project_route_legacy_normalized", {
    location: LOCATION,
    source: args.source,
    resolved: args.resolved,
  });
}

/** Buckets, not milliseconds: this is a rollout signal, not a timing series. */
function durationBucket(ms: number): "instant" | "fast" | "slow" {
  if (ms < 250) return "instant";
  if (ms < 2000) return "fast";
  return "slow";
}

export function trackProjectRouteResolved(durationMs: number): void {
  track("project_route_resolved", {
    location: LOCATION,
    outcome: "ready",
    duration_bucket: durationBucket(durationMs),
  });
}

export function trackProjectRouteInaccessible(
  reason: "malformed" | "not-a-member" | "timed-out"
): void {
  track("project_route_inaccessible", { location: LOCATION, reason });
}

export function trackProjectRouteScopeMismatch(
  guard: "redirect-loop" | "repeated-switch"
): void {
  track("project_route_scope_mismatch", { location: LOCATION, guard });
}

/**
 * `restored` — the generic stored path decided where the user landed.
 * `absent`   — nothing usable was stored (including a stored value that
 *              failed validation on the way out; it is cleared either way,
 *              and the two are indistinguishable by design).
 * `superseded` — a path was stored, but a flow with its own documented
 *              precedence (scenario, billing, CLI, API keys) won.
 */
export function trackSignInReturnRestored(
  outcome: "restored" | "absent" | "superseded"
): void {
  track("app_signin_return_restored", { location: "signin-return", outcome });
}
