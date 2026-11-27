import { SPEND_BUDGET_REACHED_MESSAGE } from "@/lib/mcpjam-limit";
import { describeAiRefusal } from "@/shared/ai-refusal-copy";
import { recognizedAiRefusalCode } from "@/shared/ai-execution-refusal";

/**
 * Why a custom judge did not grade, by the backend's code: a judge's error
 * on a run, or a refused "Test on a past iteration". Only the codes the
 * backend sends (`lib/customJudges/customJudgePass.ts`, `lib/meteredLlm.ts`
 * and the preview action) are listed.
 */
const COPY_BY_CODE: Readonly<Record<string, string>> = {
  iteration_not_gradable:
    "This iteration cannot be graded. Choose another iteration.",
  custom_judge_cap_reached:
    "This run reached its spending limit for custom judges, so the judge did not run. Use fewer judges or fewer iterations to stay under it.",
  spend_cap_exceeded:
    "The organization reached its AI spending limit, so the judge did not run. Add credits or wait for the limit to reset, then try again.",
  spend_budget_reached: SPEND_BUDGET_REACHED_MESSAGE,
  lease_lost:
    "Grading restarted before this judge ran. It runs again when grading resumes.",
  missing_api_key:
    "The suite's judge model has no provider key, so the judge did not run. Add a key for its provider, then try again.",
  no_billing_subject:
    "No account could be billed for this judge, so it did not run. Sign in and try again.",
  sign_in_required: "Sign in to run a custom judge.",
  judge_reasoning_effort_unsupported:
    "The suite's judge reasoning effort is not supported by its model. Choose a supported effort or clear it, then try again.",
};

/** Readable copy for a failure code, or undefined for one the backend never sends. */
export function customJudgeFailureCopy(
  code: string | undefined,
): string | undefined {
  if (!code) return undefined;
  const known = COPY_BY_CODE[code];
  if (known) return known;
  return recognizedAiRefusalCode(code)
    ? describeAiRefusal(code).body
    : undefined;
}
