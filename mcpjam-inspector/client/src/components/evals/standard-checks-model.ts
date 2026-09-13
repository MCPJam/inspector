import {
  STANDARD_CHECKS,
  filterSuppressedSuiteAssertions,
  normalizeSuppressedStandardCheckIds,
  type StandardCheck,
} from "@mcpjam/sdk/contract";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import { resolveCasePredicates } from "@/shared/eval-matching";
import { canonicalJson } from "@mcpjam/sdk/contract";

export type AssertionCheck = Extract<StandardCheck, { kind: "assertion" }>;
export type StandardCheckDraft = {
  predicates?: CasePredicates;
  suppressedSuiteStandardCheckIds?: string[];
};

export function standardCheckState(
  check: AssertionCheck,
  suite: Predicate[],
  draft?: StandardCheckDraft,
) {
  const inherited =
    draft?.predicates?.mode === "replace"
      ? []
      : filterSuppressedSuiteAssertions(
          suite,
          draft?.suppressedSuiteStandardCheckIds,
        );
  const local =
    draft?.predicates?.mode === "inherit"
      ? []
      : (draft?.predicates?.list ?? []);
  const matches = (rules: Predicate[]) =>
    rules.filter((rule) => rule.type === check.preset.type);
  const suiteRules = matches(inherited);
  const caseRules = matches(local);
  const rules = [...suiteRules, ...caseRules];
  const presetId = canonicalJson(check.preset);
  return {
    enabled: rules.length > 0,
    rules,
    suiteCount: suiteRules.length,
    caseCount: caseRules.length,
    customized: rules.some((rule) => canonicalJson(rule) !== presetId),
  };
}

export function toggleSuiteStandardCheck(
  rules: Predicate[],
  check: AssertionCheck,
  enabled: boolean,
): Predicate[] {
  if (!enabled) return rules.filter((rule) => rule.type !== check.preset.type);
  return rules.some((rule) => rule.type === check.preset.type)
    ? rules
    : [...rules, structuredClone(check.preset)];
}

/** Whole-run suite/case families only. Step assertions are never inputs. */
export function toggleCaseStandardCheck(
  suite: Predicate[],
  draft: StandardCheckDraft,
  check: AssertionCheck,
  enabled: boolean,
): StandardCheckDraft {
  const suppressed = new Set(draft.suppressedSuiteStandardCheckIds ?? []);
  let predicates = draft.predicates;
  if (!enabled) {
    if (suite.some((rule) => rule.type === check.preset.type))
      suppressed.add(check.id);
    if (predicates)
      predicates = {
        ...predicates,
        list: predicates.list.filter((rule) => rule.type !== check.preset.type),
      };
  } else {
    suppressed.delete(check.id);
    const effective =
      resolveCasePredicates(suite, predicates, [...suppressed]) ?? [];
    if (!effective.some((rule) => rule.type === check.preset.type)) {
      predicates =
        predicates?.mode === "replace"
          ? {
              mode: "replace",
              list: [...predicates.list, structuredClone(check.preset)],
            }
          : {
              mode: "extend",
              list: [
                ...(predicates?.mode === "extend" ? predicates.list : []),
                structuredClone(check.preset),
              ],
            };
    }
  }
  // Explicit [] lets the existing update boundary clear a persisted suppression.
  return {
    predicates,
    suppressedSuiteStandardCheckIds:
      normalizeSuppressedStandardCheckIds([...suppressed]) ?? [],
  };
}

export const STANDARD_ASSERTION_CHECKS = STANDARD_CHECKS.filter(
  (check): check is AssertionCheck => check.kind === "assertion",
);
