import { useFeatureFlagEnabled } from "posthog-js/react";
import type {
  SuiteCapabilities,
  SuiteFeatureGate,
} from "@/hooks/use-suite-capabilities";
import {
  CAPABILITY_REASON_COPY,
  featureDisabledReason,
} from "../capability-reasons";

/**
 * EFTW-90's two products share MCPJam's eval sandboxes but launch apart (spec
 * amendment v1.2), so each settings row follows its own flag. The backend
 * gates ADDING to the suite's fields on the same keys and never gates
 * clearing, so a row whose flag is off still shows what the suite holds,
 * read-only, and lets the person remove it.
 */
export const EVAL_SETUP_CLEANUP_SCRIPTS_FLAG = "eval-setup-cleanup-scripts";
/** Code evaluators and the grading box they run in (declared files, network). */
export const EVAL_CODE_EVALUATORS_FLAG = "eval-code-evaluators";

export type CodeGradingGate = {
  /** Add and edit. Otherwise stored values are read-only and removable. */
  canEdit: boolean;
  /** Why not, once something has said so. */
  reason?: string;
  /** Show the row with nothing stored, because the person has the flag. */
  showEmpty: boolean;
};

/**
 * One row's gate, from both sources: the client flag and the suite's
 * capabilities, which answer for its organization from the check that refuses
 * the save. Both must allow. A capability key the backend doesn't send (one
 * that predates it), or capabilities that couldn't be read, is unknown and
 * leaves the flag to decide. The flag counts as off until it loads.
 */
export function codeGradingGate(
  flag: boolean | undefined,
  capability: SuiteFeatureGate | undefined,
): CodeGradingGate {
  const refused = featureDisabledReason(capability);
  if (refused) {
    return { canEdit: false, reason: refused, showEmpty: flag === true };
  }
  if (flag === true) return { canEdit: true, showEmpty: true };
  return {
    canEdit: false,
    showEmpty: false,
    ...(flag === false ? { reason: CAPABILITY_REASON_COPY.flag_false } : {}),
  };
}

/** Setup and cleanup follows the scripts flag; Grading, the evaluators flag. */
export function useCodeGradingGates(
  capabilities: SuiteCapabilities | null | undefined,
): { scripts: CodeGradingGate; grading: CodeGradingGate } {
  const scriptsFlag = useFeatureFlagEnabled(EVAL_SETUP_CLEANUP_SCRIPTS_FLAG);
  const evaluatorsFlag = useFeatureFlagEnabled(EVAL_CODE_EVALUATORS_FLAG);
  const features = capabilities?.features;
  return {
    scripts: codeGradingGate(
      scriptsFlag,
      features?.[EVAL_SETUP_CLEANUP_SCRIPTS_FLAG],
    ),
    grading: codeGradingGate(
      evaluatorsFlag,
      features?.[EVAL_CODE_EVALUATORS_FLAG],
    ),
  };
}

/** The line a read-only row shows: why, and that removing still works. */
export function readOnlyNote(
  gate: CodeGradingGate,
  stored: "scripts" | "settings" | null,
): string | undefined {
  if (gate.canEdit || !gate.reason) return undefined;
  if (!stored) return `${gate.reason}.`;
  const verb = stored === "scripts" ? "still run" : "still apply";
  return `${gate.reason}. These ${stored} ${verb}, and you can remove them.`;
}
