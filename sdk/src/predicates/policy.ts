/**
 * Authored check policy — whether a predicate gates the trial.
 *
 * `role` and `severity` ride on the predicate object so every authoring
 * surface (suite default, turn check, step assertion, case override) can
 * mark a check advisory without a parallel field. They are NEVER inputs to
 * criterion identity or `implementationHash`: flipping a check from gating
 * to warn must not renumber score rows or look like a different scorer.
 *
 * Absent `role` is gating. `severity` is only meaningful on an advisory
 * check (the schema refuses the other pairing).
 */

export const CHECK_POLICY_KEYS = ["role", "severity"] as const;

export type CheckRole = "gating" | "advisory";
export type CheckSeverity = "warn";

export type CheckPolicy = {
  role?: CheckRole;
  severity?: CheckSeverity;
};

/**
 * Drop `role` / `severity` so hashing and criterion identity see the
 * underlying assertion only.
 */
export function stripCheckPolicy<T extends object>(
  predicate: T
): Omit<T, "role" | "severity"> {
  const { role: _role, severity: _severity, ...rest } = predicate as T &
    CheckPolicy;
  return rest as Omit<T, "role" | "severity">;
}

/**
 * Effective role of a check. Absent, unknown, or `"gating"` ⇒ gating.
 * Only the literal `"advisory"` is advisory — a misspelling must never
 * silently un-gate a trial.
 */
export function checkRole(
  predicate: { role?: unknown } | undefined | null
): CheckRole {
  return predicate?.role === "advisory" ? "advisory" : "gating";
}

/** Authored severity, or `undefined` when none / unrecognised. */
export function checkSeverity(
  predicate: { severity?: unknown } | undefined | null
): CheckSeverity | undefined {
  return predicate?.severity === "warn" ? "warn" : undefined;
}
