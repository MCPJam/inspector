/**
 * The VOCABULARY-2 half of the eval case and suite-settings wire, kept beside
 * `evals.ts` rather than inside it.
 *
 * Under `x-mcpjam-eval-vocabulary: 2` (`docs/evals-vocabulary-consolidation.md`,
 * "The wire") the eval authoring fields are spelled canonically:
 *
 *   - the case's rules are `assertions` (legacy `checks`, `predicates`);
 *   - the exact configured count is `iterations` (legacy `repetitions`);
 *   - the legacy per-case floor — the field vocabulary 1 calls `iterations`,
 *     stored as Convex `runs`, read by the legacy resolver as
 *     `max(runs, minimumIterations)` — is `legacyIterations` (legacy `runs`);
 *   - suite defaults are `settings.defaultAssertions` (legacy
 *     `defaultPredicates`, and the REST wire's own `checks`) and
 *     `settings.iterations` (legacy `repetitions`).
 *
 * Vocabulary 1 keeps every one of its spellings forever: it is byte-for-byte
 * today's contract and is not widened. So `evals.ts` genuinely holds both
 * vocabularies of one wire, and this module is where vocabulary 2 lives.
 *
 * Why a separate file and not a section of `evals.ts`: the vocabulary codemod
 * (`scripts/codemod/evals-vocabulary`) guards per FILE that a rename's target
 * name is not already in use beside the name it replaces, and `evals.ts` is
 * one of the files it guards for the count renames. That guard is correct —
 * two fields must not become one — and it cannot tell an expand-phase alias
 * from a merge. Housing the new spellings here keeps the guard meaningful for
 * the file it watches, and keeps every vocabulary-2 spelling in one place a
 * reader can diff against the contract.
 *
 * Everything here folds onto TODAY's internal body shape before storage.
 * `buildCaseMutationArgs` and the suite PATCH stay the single owners of "what
 * reaches Convex"; a vocabulary-2 body never forwards a canonical key to the
 * platform, so the both-spellings refusal has exactly one text and one owner.
 */

import type { z } from "zod";
import {
  CASE_FIELD_ALIASES_V2,
  SUITE_SETTINGS_ALIASES_V2,
  addBothSpellingsIssues,
  type EvalVocabulary,
} from "./eval-vocabulary.js";

// ── names ────────────────────────────────────────────────────────────────────

/** What each vocabulary calls the count fields, for messages. */
export type CountFieldNames = {
  /** The legacy per-case floor. */
  floor: string;
  /** The exact per-case count under verdict policy 2. */
  exactCount: string;
  /** The suite-level default of that exact count, as a settings path. */
  settingsExactCount: string;
};

export function countFieldNames(vocabulary: EvalVocabulary): CountFieldNames {
  return vocabulary === 2
    ? {
        floor: "legacyIterations",
        exactCount: "iterations",
        settingsExactCount: "settings.iterations",
      }
    : {
        floor: "iterations",
        exactCount: "repetitions",
        settingsExactCount: "settings.repetitions",
      };
}

// ── pairs ────────────────────────────────────────────────────────────────────

/**
 * Every pair a vocabulary-2 body refuses together, derived from the alias
 * tables the capability block advertises — so a spelling this refusal knows is
 * a spelling `GET /capabilities` lists, and vice versa. Two LEGACY spellings
 * of one field are a pair too: the contract refuses "any two of them".
 *
 * `iterations` and `legacyIterations` are never a pair: they are two different
 * fields (an exact count and a floor), not two spellings of one.
 */
function pairsFrom(
  table: Record<string, readonly string[]>,
): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (const [canonical, legacies] of Object.entries(table)) {
    for (const legacy of legacies) pairs.push([canonical, legacy] as const);
    for (let i = 0; i < legacies.length; i += 1) {
      for (let j = i + 1; j < legacies.length; j += 1) {
        pairs.push([legacies[i]!, legacies[j]!] as const);
      }
    }
  }
  return pairs;
}

export const CASE_SPELLING_PAIRS_V2 = pairsFrom(CASE_FIELD_ALIASES_V2);
export const SUITE_SPELLING_PAIRS_V2 = pairsFrom(SUITE_SETTINGS_ALIASES_V2);

// ── the case body ────────────────────────────────────────────────────────────

/**
 * The vocabulary-2 case body shape, built from vocabulary 1's.
 *
 * Same fields, re-spelled: the floor moves from `iterations` to
 * `legacyIterations` (+ `runs`), the exact count from `repetitions` to
 * `iterations` (+ `repetitions`), the rules from `checks` to `assertions`
 * (+ `checks`, `predicates`). Each legacy spelling reuses the canonical
 * field's schema, so the two cannot drift in range or shape. Nothing else is
 * re-declared, so a field added to the vocabulary-1 shape is in vocabulary 2
 * too.
 */
export function caseBodyShapeV2<
  Shape extends {
    iterations: z.ZodTypeAny;
    repetitions: z.ZodTypeAny;
    checks: z.ZodTypeAny;
  },
>(
  v1: Shape,
): Omit<Shape, "iterations" | "repetitions" | "checks"> & {
  legacyIterations: Shape["iterations"];
  runs: Shape["iterations"];
  iterations: Shape["repetitions"];
  repetitions: Shape["repetitions"];
  assertions: Shape["checks"];
  checks: Shape["checks"];
  predicates: Shape["checks"];
} {
  const { iterations: floor, repetitions: exact, checks: rules, ...rest } = v1;
  return {
    ...rest,
    /**
     * The legacy per-case count, read by the legacy resolver as a FLOOR
     * (`max(legacyIterations, suite.minimumIterations)`). Stored as `runs`.
     */
    legacyIterations: floor,
    /** Legacy spelling of `legacyIterations`. */
    runs: floor,
    /** The exact count this case runs under verdict policy 2. */
    iterations: exact,
    /** Legacy spelling of `iterations`. */
    repetitions: exact,
    /** The case's rule override. */
    assertions: rules,
    /** Legacy spellings of `assertions`. */
    checks: rules,
    predicates: rules,
  };
}

/** The both-spellings refinement for any vocabulary-2 case schema. */
export function refineCaseBodyV2(
  body: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  addBothSpellingsIssues(body, ctx, CASE_SPELLING_PAIRS_V2);
}

function firstPresent<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

/**
 * Fold a validated vocabulary-2 case body onto vocabulary 1's shape.
 *
 * PRESENCE-based (`!== undefined`), never `??`: the refinement above has
 * already refused a body carrying two spellings, so the first present value
 * is the only one — and an explicit `null` (a cleared rule override) must
 * reach storage as the clear it is.
 *
 * The floor on CREATE follows the contract exactly. A create that names an
 * exact count but no floor stores `runs = iterations` — what the legacy
 * resolver would have floored to anyway — and a create that names NEITHER
 * forwards nothing, so the platform applies the same `runs = 1` a headerless
 * create stores today. A PATCH that never mentions the floor leaves the
 * stored `runs` exactly as it was; it never derives one from the count.
 */
export function foldCaseBodyV2ToV1<
  Body extends {
    legacyIterations?: number;
    runs?: number;
    iterations?: number;
    repetitions?: number;
    assertions?: unknown;
    checks?: unknown;
    predicates?: unknown;
  },
>(
  body: Body,
  options: { forCreate: boolean },
): Omit<
  Body,
  | "legacyIterations"
  | "runs"
  | "iterations"
  | "repetitions"
  | "assertions"
  | "checks"
  | "predicates"
> & {
  iterations?: number;
  repetitions?: number;
  checks?: Body["assertions"];
} {
  const {
    legacyIterations,
    runs,
    iterations,
    repetitions,
    assertions,
    checks,
    predicates,
    ...rest
  } = body;
  const exact = firstPresent(iterations, repetitions);
  const declaredFloor = firstPresent(legacyIterations, runs);
  const floor =
    declaredFloor !== undefined
      ? declaredFloor
      : options.forCreate
        ? exact
        : undefined;
  const rules = firstPresent(assertions, checks, predicates);
  return {
    ...rest,
    ...(floor !== undefined ? { iterations: floor } : {}),
    ...(exact !== undefined ? { repetitions: exact } : {}),
    ...(rules !== undefined ? { checks: rules } : {}),
  };
}

/** The renames a case DTO undergoes from vocabulary 1 to 2, in place. */
const CASE_DTO_RENAMES: Readonly<Record<string, string>> = {
  iterations: "legacyIterations",
  repetitions: "iterations",
  checks: "assertions",
};

function renameKeys<T extends object>(
  value: T,
  renames: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[renames[key] ?? key] = entry;
  }
  return out;
}

/**
 * Project a vocabulary-1 case DTO into the vocabulary the caller asked for.
 *
 * Under 1 the DTO is returned as is — the same object, not a copy, so nothing
 * about today's response can drift by accident. Under 2 the renamed keys keep
 * their positions, so the JSON a reader diffs against a vocabulary-1 response
 * differs in exactly the renamed keys.
 */
export function projectCaseDto<
  Dto extends { iterations: number; repetitions?: number; checks?: unknown },
>(
  dto: Dto,
  vocabulary: EvalVocabulary,
):
  | Dto
  | (Omit<Dto, "iterations" | "repetitions" | "checks"> & {
      legacyIterations: number;
      iterations?: number;
      assertions?: Dto["checks"];
    }) {
  if (vocabulary === 1) return dto;
  return renameKeys(dto, CASE_DTO_RENAMES) as Omit<
    Dto,
    "iterations" | "repetitions" | "checks"
  > & {
    legacyIterations: number;
    iterations?: number;
    assertions?: Dto["checks"];
  };
}

// ── suite settings ───────────────────────────────────────────────────────────

/**
 * The vocabulary-2 suite settings shape, built from vocabulary 1's: the
 * suite-default rules move from `checks` to `defaultAssertions` (legacy
 * `defaultPredicates`, and `checks` itself), the default count from
 * `repetitions` to `iterations` (+ `repetitions`).
 */
export function suiteSettingsShapeV2<
  Shape extends { checks: z.ZodTypeAny; repetitions: z.ZodTypeAny },
>(
  v1: Shape,
): Omit<Shape, "checks" | "repetitions"> & {
  defaultAssertions: Shape["checks"];
  defaultPredicates: Shape["checks"];
  checks: Shape["checks"];
  iterations: Shape["repetitions"];
  repetitions: Shape["repetitions"];
} {
  const { checks: rules, repetitions: exact, ...rest } = v1;
  return {
    ...rest,
    /** The suite's default rules. `null` clears them. */
    defaultAssertions: rules,
    /** Legacy spellings of `defaultAssertions`. */
    defaultPredicates: rules,
    checks: rules,
    /** Verdict policy 2's default exact count per case. */
    iterations: exact,
    /** Legacy spelling of `iterations`. */
    repetitions: exact,
  };
}

/** The both-spellings refinement for the vocabulary-2 settings object. */
export function refineSuiteSettingsV2(
  settings: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  addBothSpellingsIssues(settings, ctx, SUITE_SPELLING_PAIRS_V2);
}

/** Fold validated vocabulary-2 settings onto vocabulary 1's shape. */
export function foldSuiteSettingsV2ToV1<
  Settings extends {
    defaultAssertions?: unknown;
    defaultPredicates?: unknown;
    checks?: unknown;
    iterations?: number;
    repetitions?: number;
  },
>(
  settings: Settings,
): Omit<
  Settings,
  | "defaultAssertions"
  | "defaultPredicates"
  | "checks"
  | "iterations"
  | "repetitions"
> & {
  checks?: Settings["defaultAssertions"];
  repetitions?: number;
} {
  const {
    defaultAssertions,
    defaultPredicates,
    checks,
    iterations,
    repetitions,
    ...rest
  } = settings;
  const rules = firstPresent(defaultAssertions, defaultPredicates, checks);
  const exact = firstPresent(iterations, repetitions);
  return {
    ...rest,
    ...(rules !== undefined ? { checks: rules } : {}),
    ...(exact !== undefined ? { repetitions: exact } : {}),
  };
}

/**
 * Project a vocabulary-1 suite detail into the caller's vocabulary: under 2,
 * `settings.checks` reads `settings.defaultAssertions` and the policy-2
 * default `verdictPolicyDefaults.repetitions` reads `iterations`. Both in
 * place. `minimumIterations` (the suite-level floor) and `policy` are the
 * same word in both vocabularies.
 */
export function projectSuiteDetailDto<
  Dto extends {
    settings: {
      checks: unknown;
      verdictPolicyDefaults?: { repetitions: number };
    };
  },
>(dto: Dto, vocabulary: EvalVocabulary): Dto | Record<string, unknown> {
  if (vocabulary === 1) return dto;
  const settings = renameKeys(dto.settings, { checks: "defaultAssertions" });
  if (dto.settings.verdictPolicyDefaults) {
    settings.verdictPolicyDefaults = renameKeys(
      dto.settings.verdictPolicyDefaults,
      { repetitions: "iterations" },
    );
  }
  return { ...dto, settings };
}
