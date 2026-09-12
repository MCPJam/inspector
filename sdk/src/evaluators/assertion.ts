/**
 * The assertion constructor.
 *
 * `assertion({ type: "noToolErrors" })` is the canonical spelling of what
 * `predicateScorer({ type: "noToolErrors" })` builds, and it builds it through
 * the same function — so a case authored either way produces the same
 * definition, the same opaque id, and the same `definitionHash`. That equality
 * is not incidental; it is what lets an author migrate one rule at a time
 * without the run they compare against becoming a different run.
 */

import { evaluatePredicates } from "../predicates/evaluate.js";
import { requiresRenderObservations } from "../predicates/types.js";
import { predicateScoreDefinition } from "../contract/adapters.js";
import { canonicalDigest } from "../contract/canonical.js";
import type {
  Assertion,
  EvaluatorRole,
} from "../contract/evaluator-types.js";
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
export function assertion(
  input: Assertion & { id?: string; role?: EvaluatorRole }
): AssertionEvaluator {
  const { id, ...rule } = input as Assertion & { id?: string };
  assertLocallyEvaluable(rule as Assertion);

  const named = id?.trim();
  const definition = predicateScoreDefinition(rule as Assertion, {
    ...(named ? { id: named } : {}),
    ordinal: 0,
  });

  if (!named) {
    // The WHOLE digest, not a prefix: two distinct rules sharing a truncated
    // one would mint a single id for two definitions, and the snapshot builder
    // would reject the configuration outright.
    definition.scorerId = `predicate:${rule.type}#${canonicalDigest(rule)}`;
  }

  return {
    kind: "assertion",
    rule: rule as Assertion,
    ...(named ? { id: named } : {}),
    definition,
    evaluate(context) {
      // `context.transcript` is exactly the shape the evaluator already
      // consumes — no adaptation, no second opinion about what the rule means.
      const [result] = evaluatePredicates(context.transcript, [
        rule as Assertion,
      ]);
      if (!result) {
        return {
          kind: "skipped",
          explanation: "the assertion evaluator returned no verdict",
        };
      }
      // NOT special-cased on `result.status === "error"`, deliberately, and
      // this is a known wart rather than an oversight.
      //
      // `evaluatePredicates` can return `status: "error"` — "the evidence was
      // not there" — and the two existing paths disagree about it. `EvalTest`'s
      // inline path routes it through `scoreResultFromPredicateResult`, which
      // makes it an error row carrying no value; `predicateScorer`, which this
      // function is the canonical spelling of, has no error branch and scores
      // it 0. A 0 says the server did the wrong thing, and attributing a defect
      // to a server for a measurement WE could not take is exactly the
      // mis-attribution the chain exists to avoid.
      //
      // This matches `predicateScorer` anyway, because the claim that makes the
      // migration safe is that `assertion(rule)` and `predicateScorer(rule)`
      // are the same evaluator. Fixing the attribution here would change
      // verdicts for existing callers of that path under a name advertised as
      // equivalent — which is a behaviour change wearing a rename's clothes.
      // It belongs in its own change, where its verdict impact can be reviewed.
      return {
        kind: "scored",
        score: result.passed ? 1 : 0,
        explanation: result.reason,
        ...(result.scope ? { scope: result.scope } : {}),
      };
    },
  };
}
