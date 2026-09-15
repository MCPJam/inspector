/**
 * Standard checks as authoring state — which families a suite or case has on.
 *
 * Pure. A "family" is one `STANDARD_CHECKS` assertion entry: a stable id
 * (`response.performance`), one backing predicate kind, and a preset rule.
 * The suite stores rules; a case stores an override envelope plus the family
 * ids it turned off. This module turns those into rows the scorer table can
 * list with a source and an on/off state, and turns a click back into the
 * next draft.
 */

import {
  STANDARD_CHECKS,
  normalizeSuppressedStandardCheckIds,
  type StandardAssertionCheckId,
  type StandardCheck,
} from "@mcpjam/sdk/contract";
import type { CasePredicates, Predicate } from "@/shared/eval-matching";
import { resolveCasePredicates } from "@/shared/eval-matching";

export type AssertionCheck = Extract<StandardCheck, { kind: "assertion" }>;
export type StandardCheckDraft = {
  predicates?: CasePredicates;
  suppressedSuiteStandardCheckIds?: string[];
};

export const STANDARD_ASSERTION_CHECKS = STANDARD_CHECKS.filter(
  (check): check is AssertionCheck => check.kind === "assertion",
);

const CHECK_OF_KIND = new Map<string, AssertionCheck>(
  STANDARD_ASSERTION_CHECKS.map((check) => [check.preset.type, check]),
);

/** The family a rule belongs to, when its kind backs a standard check. */
export function standardCheckOfKind(kind: string): AssertionCheck | undefined {
  return CHECK_OF_KIND.get(kind);
}

export type RuleSource = "suite" | "case";

/**
 * One rule as the table lists it: where it is stored, where it sits in that
 * list, and whether the case has turned its family off.
 *
 * A suppressed rule is still listed — unchecked and muted — so the person who
 * turned it off can see what they turned off and turn it back on. It is not
 * evaluated, and it does not count toward the stage cards.
 */
export type EffectiveRule = {
  predicate: Predicate;
  source: RuleSource;
  index: number;
  suppressed: boolean;
};

/**
 * The suite's rules, then the case's, in evaluation order.
 *
 * No draft: the suite page, every rule is the suite's. With a draft, the
 * override mode decides: `replace` drops the suite's rules entirely (they are
 * not listed — a replaced rule is not "off", it is not there), `inherit`
 * drops the case's own list, and `extend` keeps both.
 */
export function listEffectiveRules(
  suite: Predicate[],
  draft?: StandardCheckDraft,
): EffectiveRule[] {
  if (!draft) {
    return suite.map((predicate, index) => ({
      predicate,
      source: "suite",
      index,
      suppressed: false,
    }));
  }
  const suppressed = new Set(draft.suppressedSuiteStandardCheckIds ?? []);
  const rules: EffectiveRule[] = [];
  if (draft.predicates?.mode !== "replace") {
    suite.forEach((predicate, index) => {
      const family = standardCheckOfKind(predicate.type);
      rules.push({
        predicate,
        source: "suite",
        index,
        suppressed: family !== undefined && suppressed.has(family.id),
      });
    });
  }
  if (draft.predicates && draft.predicates.mode !== "inherit") {
    draft.predicates.list.forEach((predicate, index) => {
      rules.push({ predicate, source: "case", index, suppressed: false });
    });
  }
  return rules;
}

function withSuppressed(
  draft: StandardCheckDraft,
  suppressed: Iterable<string>,
): StandardCheckDraft {
  // Explicit [] lets the existing update boundary clear a persisted suppression.
  return {
    predicates: draft.predicates,
    suppressedSuiteStandardCheckIds:
      normalizeSuppressedStandardCheckIds([...suppressed]) ?? [],
  };
}

/** Turn a suite family off (or back on) for this case, touching nothing else. */
export function setSuiteFamilySuppressed(
  draft: StandardCheckDraft,
  id: StandardAssertionCheckId,
  suppressed: boolean,
): StandardCheckDraft {
  const ids = new Set(draft.suppressedSuiteStandardCheckIds ?? []);
  if (suppressed) ids.add(id);
  else ids.delete(id);
  return withSuppressed(draft, ids);
}

/**
 * Add a rule to the case's own list.
 *
 * An inheriting case becomes `extend`: the suite's rules still apply and this
 * one joins them. A replacing case stays `replace` — flattening it would
 * silently bring the suite's rules back.
 */
export function addCaseRule(
  draft: StandardCheckDraft,
  rule: Predicate,
): StandardCheckDraft {
  const current = draft.predicates;
  const predicates: CasePredicates =
    current?.mode === "replace"
      ? { mode: "replace", list: [...current.list, rule] }
      : {
          mode: "extend",
          list: [...(current?.mode === "extend" ? current.list : []), rule],
        };
  return withSuppressed(
    { ...draft, predicates },
    draft.suppressedSuiteStandardCheckIds ?? [],
  );
}

export function updateCaseRule(
  draft: StandardCheckDraft,
  index: number,
  next: Predicate,
): StandardCheckDraft {
  const current = draft.predicates;
  if (!current || current.mode === "inherit") return draft;
  const list = current.list.slice();
  list[index] = next;
  return withSuppressed(
    { ...draft, predicates: { ...current, list } },
    draft.suppressedSuiteStandardCheckIds ?? [],
  );
}

export function removeCaseRule(
  draft: StandardCheckDraft,
  index: number,
): StandardCheckDraft {
  const current = draft.predicates;
  if (!current || current.mode === "inherit") return draft;
  const list = current.list.filter((_, i) => i !== index);
  return withSuppressed(
    { ...draft, predicates: { ...current, list } },
    draft.suppressedSuiteStandardCheckIds ?? [],
  );
}

/** Suite page: a family is on when any rule of its kind is in the list. */
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

/**
 * Case page, whole family at once. Off suppresses the inherited members and
 * removes the case's own; on lifts the suppression and, only if nothing of
 * that kind is then in effect, authors the preset as a case rule. Step
 * assertions are never inputs.
 */
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
    return withSuppressed({ predicates }, suppressed);
  }
  suppressed.delete(check.id);
  const effective =
    resolveCasePredicates(suite, predicates, [...suppressed]) ?? [];
  if (effective.some((rule) => rule.type === check.preset.type)) {
    return withSuppressed({ predicates }, suppressed);
  }
  return addCaseRule(
    withSuppressed({ predicates }, suppressed),
    structuredClone(check.preset),
  );
}
