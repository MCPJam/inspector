/**
 * Authored check policy — whether a predicate gates the trial.
 *
 * `role` and `severity` ride on the predicate object so every authoring
 * surface (suite default, turn check, step assertion, case override) can
 * mark a check advisory without a parallel field. They are NEVER inputs to
 * criterion identity or `implementationHash`: flipping a check from required
 * to advisory must not renumber score rows or look like a different scorer.
 *
 * Absent `role` is required. `severity` is only meaningful on an advisory
 * check (the schema refuses the other pairing).
 *
 * `"required"` and `"gating"` are ONE value with two spellings. `"required"`
 * is canonical; `"gating"` is what every rule written before the rename says,
 * what a dialect-1 suite file says, and what the hash payload says forever.
 * Both are accepted everywhere a role is read.
 */

export const CHECK_POLICY_KEYS = ["role", "severity"] as const;

/**
 * The EFFECTIVE role a CHECK resolves to — what a reader acts on.
 *
 * Spelled with the legacy word on purpose, and narrowly: this is the type
 * `checkRole` returns, and its two members are compared against by client code
 * that also renders `ROLE_LEGEND`, which is where the word "Required" comes
 * from. Widening it to the canonical spelling here would rename an internal
 * resolved value without renaming anything a reader sees, for no gain.
 *
 * {@link AuthoredCheckRole} is the wider set an author may WRITE. The backend
 * narrows its own effective types to the canonical pair, because there the
 * resolved value IS compared against literals on gate-deciding paths and the
 * compiler finding those was the point.
 */
export type CheckRole = "gating" | "advisory";
/** What an author may spell, including the canonical `"required"`. */
export type AuthoredCheckRole = CheckRole | "required";
export type CheckSeverity = "warn";

export type CheckPolicy = {
  role?: AuthoredCheckRole;
  severity?: CheckSeverity;
};

/**
 * Drop `role` / `severity` so hashing and criterion identity see the
 * underlying assertion only.
 */
export function stripCheckPolicy<T extends object>(
  predicate: T,
): Omit<T, "role" | "severity"> {
  const {
    role: _role,
    severity: _severity,
    ...rest
  } = predicate as T & CheckPolicy;
  return rest as Omit<T, "role" | "severity">;
}

/**
 * Effective role of a check. Absent, unknown, `"gating"` or `"required"` ⇒
 * gating. Only the literal `"advisory"` is advisory — a misspelling must never
 * silently un-gate a trial.
 */
export function checkRole(
  predicate: { role?: unknown } | undefined | null,
): CheckRole {
  return predicate?.role === "advisory" ? "advisory" : "gating";
}

/**
 * True when this role value means "a failure fails the iteration".
 *
 * The ONE place the two spellings of that one value are compared. Every
 * `role === "gating"` reader in the SDK goes through here, so adding a
 * spelling is a one-line change rather than a hunt — and so a reader that
 * forgot `"required"` cannot silently drop a rule out of the gating set.
 *
 * Mirrored by `isRequiredRole` in `mcpjam-backend/convex/lib/predicates.ts`.
 */
export function isRequiredRole(role: unknown): boolean {
  return role === "gating" || role === "required";
}

/**
 * The spelling a check's role is STORED and HASHED as.
 *
 * `"required"` normalizes to absent, which is the form Gate has always been
 * written in: strip the field and a rule authored today is byte-identical to
 * one authored before roles existed. Applied before a rule is digested for an
 * anonymous scorer id and before it is uploaded, so the two spellings of one
 * rule never produce two identities.
 */
export function canonicalizeCheckRole<T extends object>(predicate: T): T {
  if (!predicate || typeof predicate !== "object") return predicate;
  if ((predicate as CheckPolicy).role !== "required") return predicate;
  const { role: _role, ...rest } = predicate as T & CheckPolicy;
  return rest as T;
}

/** {@link canonicalizeCheckRole} over a list. */
export function canonicalizeCheckRoles<T extends object>(
  predicates: readonly T[] | undefined,
): T[] | undefined {
  return Array.isArray(predicates)
    ? predicates.map(canonicalizeCheckRole)
    : undefined;
}

/** Authored severity, or `undefined` when none / unrecognised. */
export function checkSeverity(
  predicate: { severity?: unknown } | undefined | null,
): CheckSeverity | undefined {
  return predicate?.severity === "warn" ? "warn" : undefined;
}
