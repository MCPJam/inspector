/**
 * `x-mcpjam-eval-vocabulary` — the negotiation header for the eval surface.
 *
 * Absent means vocabulary 1, which is byte-for-byte today's contract: the same
 * request fields, the same refusals, the same response projection. Vocabulary 2
 * is the canonical one. Any other value is a 400, so two implementations
 * reading `docs/evals-vocabulary-consolidation.md` cannot disagree about
 * whether the same body is valid.
 *
 * This module is scoped to the VALUE projection today — the policy role, whose
 * canonical spelling is `required` and whose legacy one is `gating`. The
 * field-spelling waves (`checks` → `assertions`, the count family) extend the
 * same module rather than forking a second header reader: one place decides
 * what a request negotiated, and every projection asks it.
 *
 * Why the role needs the header at all, when a rename normally would not: a
 * published `mcpjam cloud eval gate` reads definition roles through
 * `.filter(role === "gating")`. An unannounced `required` in a response would
 * empty that CLI's gating set, and an empty gating set passes a failing run —
 * silently, and in exactly the workflow a gate exists to serve.
 */

import type { Context } from "hono";
import type { z } from "zod";
import {
  EVALUATOR_KINDS,
  PREDICATE_KINDS,
  type ScorerRole,
} from "@mcpjam/sdk/contract";
import { isRequiredRole } from "@mcpjam/sdk/predicates";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  hasUnknownVocabularyValue,
  parseVocabularyValue,
  unknownVocabularyMessage,
  vocabularyForHeader,
} from "./vocabulary-header.js";

export const EVAL_VOCABULARY_HEADER = "x-mcpjam-eval-vocabulary";

/** The vocabularies this deployment speaks. */
export type EvalVocabulary = 1 | 2;

/**
 * Parse the header. `null` means the value was present and unrecognised — the
 * caller turns that into a `VALIDATION_ERROR`, rather than guessing a
 * vocabulary for a client that asked for one we do not have.
 *
 * The mechanics live in `./vocabulary-header.ts`, shared with the API-noun
 * header: what the two negotiate differs entirely, how they negotiate must
 * not.
 */
export function parseEvalVocabulary(
  raw: string | undefined,
): EvalVocabulary | null {
  return parseVocabularyValue(raw);
}

/**
 * The vocabulary this request negotiated, and the `Vary` that goes with it.
 *
 * `Vary` is set on every call rather than only when the response actually
 * differs: a cache keyed on the wrong axis serves one client another client's
 * spelling, and "this response happened not to contain a role" is not a
 * property a cache can see.
 */
export function vocabularyOf(c: Context): EvalVocabulary {
  return vocabularyForHeader(c, EVAL_VOCABULARY_HEADER);
}

/** True when the request named a vocabulary this deployment does not speak. */
export function hasUnknownVocabulary(c: Context): boolean {
  return hasUnknownVocabularyValue(c, EVAL_VOCABULARY_HEADER);
}

/** The message a refused header gets, naming both valid values. */
export const UNKNOWN_VOCABULARY_MESSAGE = unknownVocabularyMessage(
  EVAL_VOCABULARY_HEADER,
);

/**
 * Project one role value into the spelling the caller negotiated.
 *
 * Vocabulary 1 gets `gating` for a required role whichever way it is stored —
 * which is what keeps a headerless response byte-identical to today's. Only a
 * caller that asked for vocabulary 2 sees `required`.
 *
 * Applied on the way OUT, at every DTO that carries a role. Storage is not
 * rewritten to match: a stored contract is historical evidence, and the pinned
 * contract keeps historical rows readable in the shape they were written.
 */
export function projectRoleForVocabulary(
  role: ScorerRole | string | undefined,
  vocabulary: EvalVocabulary,
): ScorerRole | undefined {
  if (role === undefined) return undefined;
  if (role === "advisory") return "advisory";
  if (!isRequiredRole(role)) return role as ScorerRole;
  return vocabulary === 2 ? "required" : "gating";
}

/**
 * Normalize one authored role into the spelling STORAGE takes.
 *
 * The inverse direction, applied on the way IN. Convex accepts both after its
 * own widening, so this is belt and braces — but it is the belt that keeps the
 * inspector's own DTO round-trip honest, and it is where a vocabulary-1 body
 * gets refused for sending a spelling it did not negotiate.
 */
export function storageRoleSpelling(
  role: ScorerRole | string | undefined,
): ScorerRole | undefined {
  if (role === undefined) return undefined;
  if (role === "required") return "gating";
  return role as ScorerRole;
}

/**
 * Does this body use a spelling the negotiated vocabulary does not accept?
 *
 * Vocabulary 1 accepts exactly today's values, including its refusals: the
 * case schemas are strict, and `required` under no header is a value today's
 * contract has never accepted. Widening vocabulary 1 to meet vocabulary 2 half
 * way is precisely what makes a negotiation boundary undecidable.
 */
export function refusesCanonicalRole(
  role: unknown,
  vocabulary: EvalVocabulary,
): boolean {
  return vocabulary === 1 && role === "required";
}

/** The message a vocabulary-1 body gets for sending `required`. */
export function canonicalRoleRefusalMessage(path: string): string {
  return (
    `${path}: role "required" needs ${EVAL_VOCABULARY_HEADER}: 2. ` +
    `Without the header this endpoint speaks today's contract, where the ` +
    `spelling is "gating".`
  );
}

/**
 * Put every authored role in a check list into the storage spelling, refusing
 * one the negotiated vocabulary does not accept.
 *
 * Returns the list unchanged and uncopied when nothing moves, which is the
 * common case — so a vocabulary-1 write is byte-identical to today's, not
 * merely equivalent to it.
 */
export function normalizeCheckRolesForVocabulary<T>(
  checks: readonly T[] | undefined,
  vocabulary: EvalVocabulary,
  path: string,
): readonly T[] | undefined {
  if (!Array.isArray(checks)) return checks;
  let changed = false;
  const out = checks.map((check, index) => {
    const role = (check as { role?: unknown } | null)?.role;
    if (refusesCanonicalRole(role, vocabulary)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        canonicalRoleRefusalMessage(`${path}[${index}].role`),
      );
    }
    if (role !== "required") return check;
    changed = true;
    const { role: _role, ...rest } = check as Record<string, unknown>;
    // Storage form for a CHECK is the absent field, not `"gating"` — the shape
    // Gate has always been written in, so the configuration revision of a rule
    // authored either way is the same string.
    return rest as T;
  });
  return changed ? out : checks;
}

/**
 * The same rule over a `{ mode, list }` check override.
 *
 * The inline-test authoring paths (`POST /runs`, `POST /suites` with `tests`)
 * carry their checks in this envelope rather than as a bare array, and they
 * reach the same storage as the case routes. Without this they were the one
 * ingress where a vocabulary-1 request could smuggle `required` past the
 * refusal every other ingress enforces.
 *
 * `undefined` and `null` pass through untouched: on a case write `null` is the
 * explicit clear sentinel and must not become an empty envelope.
 */
export function normalizeCheckRolesInOverrideForVocabulary<T>(
  override: T,
  vocabulary: EvalVocabulary,
  path: string,
): T {
  if (!override || typeof override !== "object") return override;
  const list = (override as { list?: unknown }).list;
  if (!Array.isArray(list)) return override;
  const next = normalizeCheckRolesForVocabulary(
    list,
    vocabulary,
    `${path}.list`,
  );
  return next === list ? override : ({ ...override, list: next } as T);
}

/**
 * The same rule over a `steps` array: an assert step's assertion carries a
 * role too, and it reaches the same storage and the same case signature.
 */
export function normalizeStepRolesForVocabulary<T>(
  steps: readonly T[] | undefined,
  vocabulary: EvalVocabulary,
  path: string,
): readonly T[] | undefined {
  if (!Array.isArray(steps)) return steps;
  let changed = false;
  const out = steps.map((step, index) => {
    const row = step as { kind?: unknown; assertion?: unknown } | null;
    if (!row || row.kind !== "assert") return step;
    const assertion = row.assertion as { role?: unknown } | null;
    const role = assertion?.role;
    if (refusesCanonicalRole(role, vocabulary)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        canonicalRoleRefusalMessage(`${path}[${index}].assertion.role`),
      );
    }
    if (role !== "required") return step;
    changed = true;
    const { role: _role, ...rest } = assertion as Record<string, unknown>;
    return { ...(row as object), assertion: rest } as T;
  });
  return changed ? out : steps;
}

/** The judge's storage form IS a present value, so `required` maps to `gating`. */
export function normalizeJudgeRoleForVocabulary<
  T extends { role?: unknown } | null | undefined,
>(slot: T, vocabulary: EvalVocabulary, path: string): T {
  if (!slot || typeof slot !== "object") return slot;
  const role = (slot as { role?: unknown }).role;
  if (refusesCanonicalRole(role, vocabulary)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      canonicalRoleRefusalMessage(`${path}.role`),
    );
  }
  if (role !== "required") return slot;
  return { ...(slot as object), role: "gating" } as T;
}

/**
 * Project every role in a stored check list into the negotiated spelling.
 *
 * Returns the list unchanged and uncopied when nothing moves, so a
 * vocabulary-1 response is byte-identical to today's rather than merely equal
 * to it — which is what the existing DTO fixtures pin.
 */
export function projectCheckRolesForVocabulary<T>(
  checks: readonly T[] | undefined,
  vocabulary: EvalVocabulary,
): readonly T[] | undefined {
  if (!Array.isArray(checks)) return checks;
  if (vocabulary === 1) return checks;
  let changed = false;
  const out = checks.map((check) => {
    const role = (check as { role?: unknown } | null)?.role;
    if (role === undefined || !isRequiredRole(role)) return check;
    changed = true;
    return { ...(check as object), role: "required" } as T;
  });
  return changed ? out : checks;
}

/** The same projection over a `steps` array's assert-step assertions. */
export function projectStepRolesForVocabulary<T>(
  steps: readonly T[] | undefined,
  vocabulary: EvalVocabulary,
): readonly T[] | undefined {
  if (!Array.isArray(steps)) return steps;
  if (vocabulary === 1) return steps;
  let changed = false;
  const out = steps.map((step) => {
    const row = step as { kind?: unknown; assertion?: unknown } | null;
    if (!row || row.kind !== "assert") return step;
    const role = (row.assertion as { role?: unknown } | null)?.role;
    if (role === undefined || !isRequiredRole(role)) return step;
    changed = true;
    return {
      ...(row as object),
      assertion: { ...(row.assertion as object), role: "required" },
    } as T;
  });
  return changed ? out : steps;
}

// ── field spellings ──────────────────────────────────────────────────────────

/**
 * The legacy spellings a VOCABULARY-2 body may use for each canonical field,
 * exactly as the contract's "Capability" section pins them.
 *
 * `iterations` is absent from `legacyIterations` on purpose: under vocabulary
 * 1 that key IS the floor, but under vocabulary 2 it is the exact count. One
 * key means two things across the boundary, which is exactly why the
 * negotiated vocabulary — never the presence of a field — decides which sense
 * a body means. These tables are also what the vocabulary-2 request schemas
 * and their both-spellings refusals are built from, so the capability can
 * never advertise a spelling the schema does not accept.
 */
export const CASE_FIELD_ALIASES_V2 = {
  assertions: ["checks", "predicates"],
  iterations: ["repetitions"],
  legacyIterations: ["runs"],
} as const;

/**
 * `checks` is listed beside `defaultPredicates` because it is the REST wire's
 * own vocabulary-1 spelling of the suite's default rules (`settings.checks` →
 * Convex `defaultPredicates`), and a vocabulary-2 body may still send it.
 */
export const SUITE_SETTINGS_ALIASES_V2 = {
  defaultAssertions: ["defaultPredicates", "checks"],
  iterations: ["repetitions"],
} as const;

/**
 * What this deployment understands, advertised on the project capabilities
 * read so a client reads the value rather than inferring support from the
 * presence of a field on an unrelated object.
 */
export const EVAL_VOCABULARY_CAPABILITY = {
  version: 2,
  evaluatorKinds: EVALUATOR_KINDS,
  assertionKinds: PREDICATE_KINDS,
  fields: {
    assertions: CASE_FIELD_ALIASES_V2.assertions,
    defaultAssertions: SUITE_SETTINGS_ALIASES_V2.defaultAssertions,
    iterations: CASE_FIELD_ALIASES_V2.iterations,
    legacyIterations: CASE_FIELD_ALIASES_V2.legacyIterations,
  },
} as const;

// ── both spellings of one field ──────────────────────────────────────────────

/**
 * The refusal for a body that spells one field twice — the contract's exact
 * sentence, shared by every surface that accepts two spellings so a caller
 * reads one message whichever route they hit.
 */
export function bothSpellingsMessage(
  canonical: string,
  legacy: string,
): string {
  return `Send ${canonical} or ${legacy}, not both — they are two spellings of one field.`;
}

/**
 * Add one issue per pair a body spells twice.
 *
 * Decided by PRESENCE, not truthiness: an explicit `null` is a clear the
 * storage layer must see, so it counts as "sent" here exactly as a value does.
 * Refused rather than resolved by precedence — `{ runs: 3, legacyIterations:
 * 5 }` is a caller who believes both landed, and picking one silently is the
 * same class of bug as stripping it.
 */
export function addBothSpellingsIssues(
  body: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pairs: ReadonlyArray<readonly [canonical: string, legacy: string]>,
): void {
  for (const [canonical, legacy] of pairs) {
    if (body[canonical] !== undefined && body[legacy] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [canonical],
        message: bothSpellingsMessage(canonical, legacy),
      });
    }
  }
}
