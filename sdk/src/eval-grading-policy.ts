/**
 * The SDK's integration seam for the ONE grading policy: how a suite file, a
 * hosted suite read and a reported run each reach the canonical contract, and
 * how an edit gets back to the hosted API.
 *
 * `contract/grading-policy.ts` is the model and the pure adapters; it knows
 * nothing about the platform DTO, the suite-file loader's resolved view, or
 * what a PATCH body looks like. This module is the layer that connects them,
 * and it is where the two integration rules the contract cannot enforce on its
 * own live:
 *
 *  1. **Reading a configuration must never switch it.** Every function here is
 *     a read or a PLAN. Nothing writes, and no read materializes a field a
 *     suite did not have.
 *  2. **An answer we cannot establish is refused, not guessed.** An API
 *     deployment that predates the per-case policy omits `policy` and
 *     `verdictPolicyVersion` on EVERY suite, per-case ones included, so a
 *     response from such a deployment cannot distinguish the two scopes.
 *     {@link gradingPolicyFromPlatformSuiteSettings} refuses that case rather
 *     than reporting the suite-wide policy, because guessing there would read
 *     a historical percent as a fraction — or the reverse.
 */

import {
  LEGACY_SUITE_WIDE_THRESHOLD_PERCENT,
  hostedGradingStorageFromDto,
  planEvalGradingPolicyEdit,
  resolveGradingPolicyFromHostedSuite,
  resolveGradingPolicyFromRunReporting,
  resolveGradingPolicyFromSuiteFile,
  type EvalGradingPolicyEdit,
  type EvalGradingPolicyRefusal,
  type EvalGradingPolicySettingsPatch,
  type EvalRunReportingProducer,
  type ResolvedEvalGradingPolicy,
} from "./contract/grading-policy.js";
import {
  declareEvalSuiteFileValidity,
  type ResolvedEvalSuiteFile,
} from "./suite-file-loader.js";
import type { EvalSuiteFile } from "./contract/suite-file.js";
import type { PlatformEvalSuiteSettings } from "./platform/types.js";

// ── suite files ──────────────────────────────────────────────────────────────
/**
 * One authored case's count, whichever dialect spelled it.
 *
 * Dialect 1 says `repetitions` and dialect 2 says `iterations`; they are one
 * field under two names, and the loader's own docblock says a reader of the
 * resolved view never sees the dialect-1 word. This reads the AUTHORED case,
 * so it has to know both.
 */
function authoredCaseIterations(entry: {
  iterations?: number;
  repetitions?: number;
}): number | undefined {
  return entry.iterations ?? entry.repetitions;
}

/**
 * The grading policy a loaded suite file describes.
 *
 * Takes BOTH halves of the load result, and the split is the point.
 *
 * `defaults` come from the RESOLVED view, because the documented defaults are
 * part of the policy a run is decided against. The one subtlety there is
 * validity: the resolved block's `coverage` is a union with no wire spelling,
 * and the canonical adapter wants the DECLARED block so that an omitted
 * `minEligibleTrials` stays omitted and keeps selecting the stricter
 * all-configured-attempted rule. `declareEvalSuiteFileValidity` is the
 * existing lossless inverse, so this goes back through it rather than reaching
 * into the resolved shape — which is the bug that function was added to stop.
 *
 * `caseOverrides` come from the AUTHORED file, because a resolved case always
 * carries a count and a threshold — the defaults are already applied to it.
 * Reading overrides from the resolved view would therefore report every case
 * as overriding, which is not what an override is, and would make a suite
 * file's policy incomparable with a hosted suite's (where the adapter lists
 * only the cases whose column is actually set).
 *
 * Cases are read from `authored.cases`, not `resolved.enabledCases`: a
 * disabled case still has authored settings, and dropping its override here
 * would make the policy change when somebody re-enables it.
 */
export function gradingPolicyFromLoadedSuiteFile(loaded: {
  authored: Pick<EvalSuiteFile, "cases">;
  resolved: ResolvedEvalSuiteFile;
}): ResolvedEvalGradingPolicy {
  return resolveGradingPolicyFromSuiteFile({
    defaults: {
      iterations: loaded.resolved.defaults.iterations,
      passThreshold: loaded.resolved.defaults.passThreshold,
      validity: declareEvalSuiteFileValidity(loaded.resolved.defaults.validity),
    },
    cases: (loaded.authored.cases ?? []).map((entry) => {
      const iterations = authoredCaseIterations(
        entry as { iterations?: number; repetitions?: number }
      );
      return {
        ...(entry.id !== undefined ? { id: entry.id } : {}),
        title: entry.title,
        ...(iterations !== undefined ? { iterations } : {}),
        ...(entry.passThreshold !== undefined
          ? { passThreshold: entry.passThreshold }
          : {}),
      };
    }),
  });
}

// ── hosted suites ────────────────────────────────────────────────────────────
/**
 * Why a hosted suite's grading policy could not be read.
 *
 * One member, and it is a CAPABILITY answer rather than a policy one: the
 * deployment did not tell us which criterion decides this suite's runs. It is
 * not "this suite has no policy" — every suite has one — so a surface renders
 * it as "this deployment cannot say", never as a scope.
 */
export const GRADING_POLICY_READ_REFUSALS = [
  "deploymentDoesNotReportPolicy",
] as const;
export type GradingPolicyReadRefusal =
  (typeof GRADING_POLICY_READ_REFUSALS)[number];

export type GradingPolicyReadResult =
  | { ok: true; policy: ResolvedEvalGradingPolicy }
  | { ok: false; refusal: GradingPolicyReadRefusal; message: string };

/**
 * The grading policy a hosted suite's PUBLIC settings describe.
 *
 * Refuses when the deployment does not report which policy decides the suite.
 * `settings.policy` is the field the API added to remove exactly this
 * inference; `verdictPolicyVersion` is checked too, because a deployment that
 * reports the version but not the word still answers the question. When
 * NEITHER is present the response is from a deployment that predates both, and
 * a suite-wide suite and a per-case suite are indistinguishable in it.
 *
 * Reporting the suite-wide policy in that case would be the worst available
 * outcome: a per-case suite's stored `passThreshold: 0.9` would be described
 * as a 0.9% suite-wide bar, and an editor built on that reading would write a
 * percent onto a fraction field.
 */
export function gradingPolicyFromPlatformSuiteSettings(
  settings: PlatformEvalSuiteSettings
): GradingPolicyReadResult {
  if (
    settings.policy === undefined &&
    settings.verdictPolicyVersion === undefined
  ) {
    return {
      ok: false,
      refusal: "deploymentDoesNotReportPolicy",
      message:
        "This deployment does not report which criterion decides the suite's " +
        "runs (neither settings.policy nor settings.verdictPolicyVersion is " +
        "present), so a suite-wide and a per-case suite cannot be told apart " +
        "in its response. Reading it either way would describe a threshold " +
        "the suite does not use.",
    };
  }
  return {
    ok: true,
    policy: resolveGradingPolicyFromHostedSuite(
      hostedGradingStorageFromDto({
        minimumAccuracy: settings.minimumAccuracy,
        minimumIterations: settings.minimumIterations,
        verdictPolicyVersion: settings.verdictPolicyVersion,
        verdictPolicyDefaults: settings.verdictPolicyDefaults,
      })
    ),
  };
}

// ── the reviewed settings edit ───────────────────────────────────────────────
/**
 * The PATCH body a reviewed grading-policy edit sends.
 *
 * `settings` is the existing sub-object and nothing else; the two siblings are
 * the compare-and-set and the audit trail. No new wire field.
 */
export type GradingPolicyUpdateBody = {
  settings: EvalGradingPolicySettingsPatch;
  /**
   * The suite's `revisionNumber` as read. ALWAYS sent when the deployment
   * records revisions, even though the route only mandates it for a
   * quality-gate edit: a grading threshold read, edited and written back
   * without a precondition silently overwrites whatever landed in between, and
   * "the threshold is 0.9" is exactly the kind of fact two people edit at once.
   */
  expectedRevisionNumber?: number;
  /** The audited reason, when the caller supplied one. */
  revisionNote?: string;
};

export type GradingPolicyUpdatePlan =
  | {
      ok: true;
      /** Empty `settings` means the edit changed nothing — send no request. */
      body: GradingPolicyUpdateBody;
      changed: readonly (keyof EvalGradingPolicyEdit)[];
      /** True when nothing changed, so a caller can skip the PATCH entirely. */
      noop: boolean;
    }
  | {
      ok: false;
      refusal: EvalGradingPolicyRefusal | GradingPolicyReadRefusal;
      message: string;
    };

/**
 * Plan a grading-policy edit against a hosted suite's current settings.
 *
 * THE reviewed settings operation, and the only sanctioned way an edit reaches
 * the hosted API from the SDK. It reads the current scope, preserves it, and
 * writes the field and units that scope already uses — so editing an old
 * suite's threshold needs no policy toggle and cannot migrate it. Three
 * outcomes, and the third is the one that matters:
 *
 *   - a change → the PATCH body, with the precondition carried;
 *   - no change → `noop: true` and an EMPTY `settings`, so a caller sends
 *     nothing and the suite's `configRevision` does not rotate;
 *   - unrepresentable → a refusal naming the operation that does exist, with
 *     no partial body. An edit this cannot express is refused whole.
 *
 * A malformed edit (a percent where a fraction belongs, a count out of range,
 * an unknown field) THROWS from the contract's own validation rather than
 * returning a refusal — that is a programming error, not something a user
 * chose. See `assertPlannableEdit`.
 */
export function planPlatformSuiteGradingUpdate(args: {
  settings: PlatformEvalSuiteSettings;
  /** The suite's `revisionNumber`, or `null` on a deployment without them. */
  revisionNumber?: number | null;
  edit: EvalGradingPolicyEdit;
  revisionNote?: string;
}): GradingPolicyUpdatePlan {
  const read = gradingPolicyFromPlatformSuiteSettings(args.settings);
  if (!read.ok) {
    return { ok: false, refusal: read.refusal, message: read.message };
  }
  const plan = planEvalGradingPolicyEdit(read.policy, args.edit);
  if (!plan.ok) {
    return { ok: false, refusal: plan.refusal, message: plan.message };
  }
  const noop = plan.changed.length === 0;
  return {
    ok: true,
    noop,
    changed: plan.changed,
    body: {
      settings: plan.settings,
      ...(typeof args.revisionNumber === "number"
        ? { expectedRevisionNumber: args.revisionNumber }
        : {}),
      ...(args.revisionNote !== undefined
        ? { revisionNote: args.revisionNote }
        : {}),
    },
  };
}

// ── reported runs ────────────────────────────────────────────────────────────
/**
 * The grading policy ONE reported run was decided under.
 *
 * `producer` is not a detail: `hosted` measures variant-collapsed CASES and
 * `localFallback` measures the ITERATIONS the reporter was handed, so the same
 * `minimumPassRate` decides a three-case suite run five times each differently
 * (3 units versus 15). A caller that knows which summary it is holding must
 * say so.
 */
export function gradingPolicyForReportedRun(args: {
  minimumPassRate?: number;
  producer: EvalRunReportingProducer;
}): ResolvedEvalGradingPolicy {
  return resolveGradingPolicyFromRunReporting(args);
}

/**
 * The suite-wide threshold a reported run falls back to.
 *
 * Re-exported under the SDK's own entry so the reporter and the CLI stop
 * spelling the literal `100` beside a `??`. It is a PRODUCER fallback, not a
 * stored value.
 */
export { LEGACY_SUITE_WIDE_THRESHOLD_PERCENT };
