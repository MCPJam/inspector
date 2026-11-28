/**
 * A suite's code evaluators as suite settings edit them (EFTW-90): the list
 * in the settings draft, the `eval-code-evaluators` gate, and the grading
 * mode, which decides what a run would accept.
 *
 * Run start refuses any code evaluator below `dual_write` and a Required one
 * below `enforce` (`assertCodeEvaluatorRunPreconditions`). The library offers
 * nothing those rules would refuse, and says why. Run start still decides;
 * this reads the mode from the suite row, which can't see a deployment-wide
 * verdict-policy ceiling.
 */
import type { Dispatch } from "react";
import { MAX_CODE_EVALUATORS } from "@mcpjam/sdk/contract";
import type { CodeGradingGate } from "../code-grading/code-grading-flags";
import type { SuiteScripts } from "../code-grading/code-grading-values";
import type {
  SuiteSettingsAction,
  SuiteSettingsDraft,
} from "../suite-settings-draft";
import type { EvalSuite } from "../types";
import {
  CODE_EVALUATOR_LIMIT_COPY,
  type CodeEvaluator,
} from "./code-evaluator-model";
import type { CodeEvaluatorTestTarget } from "./code-evaluator-test-panel";

/** Lowest to highest, as the backend orders them. */
const GRADING_MODES = ["off", "shadow", "dual_write", "enforce"] as const;
export type SuiteGradingMode = (typeof GRADING_MODES)[number];

/**
 * The mode the suite's next run would grade at. An absent or unknown stored
 * mode reads as `off`, as the runner reads it, and `enforce` counts only on a
 * suite under verdict policy v2: run start lowers it to `dual_write` on a
 * legacy suite.
 */
export function suiteGradingMode(
  suite: Pick<EvalSuite, "gradingEngine" | "verdictPolicyVersion">,
): SuiteGradingMode {
  const stored =
    GRADING_MODES.find((mode) => mode === suite.gradingEngine?.mode) ?? "off";
  return stored === "enforce" && suite.verdictPolicyVersion !== 2
    ? "dual_write"
    : stored;
}

function writesScores(mode: SuiteGradingMode): boolean {
  return mode === "dual_write" || mode === "enforce";
}

export type SuiteCodeEvaluators = {
  evaluators: readonly CodeEvaluator[];
  /** Replaces the list in the settings draft; an empty list clears it. */
  onChange: (next: readonly CodeEvaluator[]) => void;
  gate: CodeGradingGate;
  gradingMode: SuiteGradingMode;
  /** Setup and cleanup scripts share the evaluators' size cap. */
  scripts: SuiteScripts | undefined;
  /** For Test on a past iteration; absent for a suite outside a project. */
  test?: CodeEvaluatorTestTarget;
};

/** The suite settings draft's code evaluators, for the library and the list. */
export function suiteCodeEvaluators({
  suite,
  draft,
  dispatch,
  gate,
}: {
  suite: Pick<
    EvalSuite,
    "_id" | "projectId" | "gradingEngine" | "verdictPolicyVersion"
  >;
  draft: SuiteSettingsDraft;
  dispatch: Dispatch<SuiteSettingsAction>;
  gate: CodeGradingGate;
}): SuiteCodeEvaluators {
  return {
    evaluators: draft.current.codeEvaluators ?? [],
    onChange: (next) =>
      dispatch({
        type: "edit",
        key: "codeEvaluators",
        // "None" has one spelling in the draft, so a list emptied by hand
        // doesn't read as an unsaved change.
        value: next.length ? [...next] : undefined,
      }),
    gate,
    gradingMode: suiteGradingMode(suite),
    scripts: draft.current.scripts,
    // The test runs with the network the draft would save.
    ...(suite.projectId
      ? {
          test: {
            projectId: suite.projectId,
            suiteId: suite._id,
            network: draft.current.grading?.network === "web" ? "web" : "none",
          },
        }
      : {}),
  };
}

export const CODE_EVALUATORS_NEED_GRADING_COPY =
  "Code evaluators need a suite on the current verdict policy with grading on. Use an assertion, decision question or judge prompt instead.";

/**
 * The Code card: a reason it is off, `null` to offer it, or `undefined` to
 * leave it out while the flag is off, so nobody sees a feature they can't
 * have yet.
 */
export function codeMethodAvailability(
  code: SuiteCodeEvaluators,
): string | null | undefined {
  if (!code.gate.canEdit) {
    return code.gate.showEmpty
      ? `${code.gate.reason ?? "Not available for this suite"}.`
      : undefined;
  }
  if (!writesScores(code.gradingMode)) return CODE_EVALUATORS_NEED_GRADING_COPY;
  if (code.evaluators.length >= MAX_CODE_EVALUATORS) {
    return CODE_EVALUATOR_LIMIT_COPY;
  }
  return null;
}

/** Why Required isn't offered, when the suite's grading can't enforce it. */
export function requiredRoleRefusal(
  mode: SuiteGradingMode,
): string | undefined {
  return mode === "enforce"
    ? undefined
    : "Required needs this suite's grading set to Enforce. Until it is, this evaluator can only be Advisory.";
}

/** Why runs won't start with the evaluators the suite holds, if they won't. */
export function codeEvaluatorRunRefusal(
  code: Pick<SuiteCodeEvaluators, "evaluators" | "gradingMode">,
): string | undefined {
  if (code.evaluators.length === 0) return undefined;
  if (!writesScores(code.gradingMode)) {
    return "Runs of this suite won't start while it has code evaluators, which need the current verdict policy with grading on. Remove them to run the suite.";
  }
  if (
    code.gradingMode !== "enforce" &&
    code.evaluators.some((evaluator) => evaluator.role === "required")
  ) {
    return "Runs of this suite won't start while a code evaluator is Required, which needs grading set to Enforce. Make it Advisory to run the suite.";
  }
  return undefined;
}
