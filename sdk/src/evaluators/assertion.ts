/**
 * The assertion constructor.
 *
 * `assertion({ type: "noToolErrors" })` is the canonical spelling of what
 * `predicateScorer({ type: "noToolErrors" })` builds, and it IS that scorer:
 * the definition, the opaque id and the verdict all come from
 * `predicateScorer`, so a case authored either way produces the same
 * definition, the same opaque id, and the same `definitionHash`. That equality
 * is not incidental; it is what lets an author migrate one rule at a time
 * without the run they compare against becoming a different run.
 *
 * Delegating, rather than rebuilding the definition beside it, is what keeps
 * the id template in ONE place. `predicateScorer`, `adapters.ts` and
 * `derive.ts` are frozen identities; a copy of their id minting here is a copy
 * that can drift from them silently.
 */

import {
  CHECK_POLICY_KEYS,
  checkRole,
  stripCheckPolicy,
  type CheckPolicy,
} from "../predicates/policy.js";
import {
  predicateSchema,
  requiresRenderObservations,
} from "../predicates/types.js";
import { predicateScorer } from "../scorers/predicate-scorer.js";
import type { Assertion, EvaluatorRole } from "../contract/evaluator-types.js";
import type { ScoreRawOutcome } from "../contract/types.js";
import { toEvaluatorRawOutcome } from "./outcome.js";
import type { AssertionEvaluator } from "./types.js";

/**
 * Refuse an assertion a local run can never satisfy.
 *
 * The widget kinds read `renderObservations`, which only the hosted headless
 * runner produces, and they fail CLOSED — so accepting one here would mean
 * every iteration fails with "no render observations" and the author cannot
 * tell a real regression from an unsupported rule. Failing at construction says
 * exactly what is wrong, once.
 */
function assertLocallyEvaluable(rule: Assertion): void {
  if (!requiresRenderObservations(rule.type)) return;
  throw new Error(
    `Assertion ${rule.type} needs widget render observations, which only a ` +
      `hosted run captures. Remove it from this code-first evaluator, or move ` +
      `the case to a hosted eval suite.`
  );
}

/**
 * An assertion, optionally named.
 *
 * `id` is split off BEFORE the definition is built. It is identity, not rule
 * content: leaving it on the object would fold it into `implementationHash`,
 * so naming a rule would change the digest of what that rule does and read as
 * an edit to the rule itself on every comparison.
 *
 * An unnamed assertion gets a CONTENT-derived id rather than a positional one,
 * because a standalone evaluator has no position — two anonymous rules of the
 * same type would otherwise both mint `#0` and collide in the snapshot. Inside
 * a case the runner re-mints positionally, which is what keeps
 * `predicates: [a, b]` and `evaluators: [assertion(a), assertion(b)]`
 * identical. Either way the id is `generated`, and a gate refuses to select one.
 */
/**
 * Where each check-policy key travels when `assertion()` hands a rule to
 * `predicateScorer`. Typed over `CHECK_POLICY_KEYS`, so adding a policy key
 * there fails to compile here until someone decides where the new key goes —
 * rather than leaving it on the rule, where it would silently fold into the
 * content-derived id.
 */
const POLICY_KEY_CHANNEL: Record<(typeof CHECK_POLICY_KEYS)[number], string> = {
  role: "predicateScorer options.role",
  severity: "the rule object (predicateScorer has no severity option)",
};
void POLICY_KEY_CHANNEL;

/**
 * An assertion, optionally named.
 *
 * `assertion({ ...rule, role, id })` is `predicateScorer(rule, { role, id })`,
 * byte for byte. An author migrating writes the policy and the name ON the rule;
 * `predicateScorer` takes them as options. So both are split off here before
 * delegating:
 *
 * - `id` is identity, not rule content. It goes to `options.id` unchanged, so a
 *   whitespace-only id behaves exactly as it does in `predicateScorer` (it is
 *   not a name, and the positional `predicate:<type>#0` id is minted).
 * - `role` goes to `options.role`. Left on the rule it would reach the
 *   content-derived id — `predicate:<type>#<digest of the whole rule>` — and
 *   mint a different `scorerId` and `definitionHash` than the options spelling,
 *   so `eval gate --baseline` would read the migration as an evaluator removed
 *   and another added.
 * - `severity` stays on the rule. See {@link POLICY_KEY_CHANNEL}.
 *
 * An unnamed assertion gets a CONTENT-derived id rather than a positional one,
 * because a standalone evaluator has no position — two anonymous rules of the
 * same type would otherwise both mint `#0` and collide in the snapshot. Either
 * way the id is `generated`, and a gate refuses to select one.
 */
export function assertion(
  input: Assertion & { id?: string; role?: EvaluatorRole }
): AssertionEvaluator {
  const { id, ...authored } = input as Assertion & { id?: string };
  assertLocallyEvaluable(authored as Assertion);

  // The policy invariants live in the authoring schema, and `predicateScorer`
  // does not check them: it defaults an unroled definition to `role: "gating"`.
  // Without this, `assertion({ type: "noEndingQuestion" })` type-checks, builds
  // and lets a heuristic fail a release gate — the one thing the observation
  // rule exists to prevent. Severity's rule rides along for the same reason.
  const validated = predicateSchema.safeParse(authored);
  if (!validated.success) {
    throw new Error(
      `assertion(): ${validated.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }

  const policy = authored as CheckPolicy;
  const rule = {
    ...stripCheckPolicy(authored),
    // `predicateScorer` has no severity option, so the rule object is the
    // only channel severity has — and its content-derived id digests the rule
    // it is handed. Dropping severity here would mint a different id than
    // `predicateScorer(ruleWithSeverity, { role })` for every unnamed rule.
    ...(policy.severity !== undefined ? { severity: policy.severity } : {}),
  } as Assertion;

  const scorer = predicateScorer(rule, {
    ...(id !== undefined ? { id } : {}),
    ...(policy.role !== undefined ? { role: checkRole(policy) } : {}),
  });
  const named = id?.trim();

  return {
    kind: "assertion",
    rule: authored as Assertion,
    ...(named ? { id: named } : {}),
    definition: scorer.definition,
    evaluate(context, signal) {
      // NOT special-cased on `result.status === "error"`, deliberately, and
      // this is a known wart rather than an oversight.
      //
      // `evaluatePredicates` can return `status: "error"` — "the evidence was
      // not there" — and the two existing paths disagree about it. `EvalTest`'s
      // inline path routes it through `scoreResultFromPredicateResult`, which
      // makes it an error row carrying no value; `predicateScorer`, which this
      // function delegates to, has no error branch and scores it 0. A 0 says
      // the server did the wrong thing, and attributing a defect to a server
      // for a measurement WE could not take is exactly the mis-attribution the
      // chain exists to avoid.
      //
      // This matches `predicateScorer` anyway, because the claim that makes the
      // migration safe is that `assertion(rule)` and `predicateScorer(rule)`
      // are the same evaluator. Fixing the attribution here would change
      // verdicts for existing callers of that path under a name advertised as
      // equivalent — which is a behaviour change wearing a rename's clothes.
      // It belongs in its own change, where its verdict impact can be reviewed.
      const outcome = scorer.score(context, signal);
      return isPromiseLike(outcome)
        ? Promise.resolve(outcome).then(toEvaluatorRawOutcome)
        : toEvaluatorRawOutcome(outcome);
    },
  };
}

function isPromiseLike(
  value: ScoreRawOutcome | Promise<ScoreRawOutcome>
): value is Promise<ScoreRawOutcome> {
  return typeof (value as { then?: unknown }).then === "function";
}
