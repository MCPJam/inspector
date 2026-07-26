/**
 * SEP-2350 scope step-up lifecycle — the one place that decides what happens to
 * a `403 insufficient_scope` and to the bounded step-up budget.
 *
 * Every surface that calls an MCP primitive has the same two obligations:
 *
 * - **on failure**, drive a bounded union-scope re-authorization when the
 *   challenge is actionable; and
 * - **on success**, reset the budget, so a later legitimate step-up starts
 *   fresh instead of inheriting a spent count.
 *
 * Those obligations used to be re-implemented per surface, which is how the
 * agent-driven entry points on Prompts and Resources ended up calling the same
 * API as their on-screen buttons while silently skipping both halves. A missed
 * failure-drive dead-ends re-authorization; a missed success-reset is worse,
 * because it surfaces much later as "step-up stopped working" on a different
 * screen. {@link runWithScopeStepUp} exists so a caller cannot express the
 * operation without the lifecycle.
 *
 * The in-flight registry is deliberately **module-level**, not per-surface:
 * "one step-up at a time" is a property of the browser and of the server's
 * budget, not of a component. Two surfaces racing the same 403 (an on-screen
 * read and an agent-driven one, say) must produce one redirect, not two.
 */

import {
  insufficientScopeFromError,
  isActionableStepUpChallenge,
  parseInsufficientScopeChallenge,
  type InsufficientScopeChallenge,
} from "@/lib/apis/insufficient-scope";
import {
  applyToolCallStepUp,
  resetToolCallStepUp,
} from "@/state/oauth-orchestrator";
import type { ServerWithName } from "@/state/app-types";

/**
 * Servers with a step-up in flight. Module-level so the dedup holds ACROSS
 * surfaces; keyed by server name, cleared when the attempt settles.
 */
const inFlight = new Set<string>();

/** Test seam: no production caller should need this. */
export function __resetScopeStepUpInFlightForTests(): void {
  inFlight.clear();
}

/**
 * Clears the bounded step-up counter after a successful operation.
 *
 * Best-effort by design: a failed reset must never mask the success that
 * triggered it.
 */
export function resetScopeStepUp(server: ServerWithName | undefined): void {
  if (!server) return;
  try {
    resetToolCallStepUp(server);
  } catch {
    // Best-effort: swallowed so a failed reset cannot mask the success that
    // triggered it. Logging is deliberately absent — this module is plain (the
    // app's logger is a hook) and every caller already surfaces its own error.
  }
}

/**
 * Drives the bounded union-scope re-authorization for an actionable challenge.
 *
 * Only a challenge naming a `requiredScope` (or a `resourceMetadataUrl` to
 * discover one) is worth a redirect — an `errorDescription`-only challenge
 * would consume the one-attempt budget with nothing to widen. On `reauthorize`
 * this redirects the browser; `throw` / `manual` leave the caller's surfaced
 * error in place, so callers keep reporting failures exactly as they do now.
 */
export function driveScopeStepUp(
  server: ServerWithName | undefined,
  challenge: InsufficientScopeChallenge | undefined,
): void {
  if (!server) return;
  if (!isActionableStepUpChallenge(challenge)) return;
  const key = server.name;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void applyToolCallStepUp(server, {
    requiredScope: challenge.requiredScope,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
  })
    .catch(() => {
      // The operation's own error is already surfaced by the caller, so a
      // failed step-up has nothing further to report to the user.
    })
    .finally(() => {
      inFlight.delete(key);
    });
}

/** {@link driveScopeStepUp} for a thrown error (prompts, resources, …). */
export function driveScopeStepUpFromError(
  server: ServerWithName | undefined,
  error: unknown,
): void {
  driveScopeStepUp(server, insufficientScopeFromError(error));
}

/**
 * {@link driveScopeStepUp} for surfaces whose failure arrives as a field on a
 * RESULT object rather than as a throw (tool execution, the playground).
 */
export function driveScopeStepUpFromChallenge(
  server: ServerWithName | undefined,
  rawChallenge: unknown,
): void {
  driveScopeStepUp(server, parseInsufficientScopeChallenge(rawChallenge));
}

/**
 * Runs a promise-shaped MCP operation with the full lifecycle attached:
 * success resets the budget, a `403 insufficient_scope` drives the step-up, and
 * the error is re-thrown untouched so the caller's own handling is unchanged.
 *
 * This is the form every promise-shaped call site should use — including the
 * agent-driven ones. Wrapping the call is what makes the lifecycle impossible
 * to forget when a new entry point is added.
 */
export async function runWithScopeStepUp<T>(
  server: ServerWithName | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    resetScopeStepUp(server);
    return result;
  } catch (error) {
    driveScopeStepUpFromError(server, error);
    throw error;
  }
}
