/**
 * Why the server refused an eval launch, kept on the Error the run sheet
 * catches, so the sheet can offer the fix that reason has.
 */
import { buildEvaluateSuiteRunPath } from "@/lib/app-navigation";
import { MCPJAM_HOSTED_APP_ORIGIN } from "@/lib/oauth/constants";

/**
 * The backend refused a run whose setup or cleanup scripts, files to copy or
 * Required code evaluators need eval sandboxes this Inspector can't start.
 */
export const CODE_EVALUATORS_UNAVAILABLE = "EVAL_CODE_EVALUATORS_UNAVAILABLE";

type WithReason = Error & { reason?: string };

export function launchReasonOf(error: unknown): string | undefined {
  const reason = error instanceof Error ? (error as WithReason).reason : undefined;
  return typeof reason === "string" ? reason : undefined;
}

/** `target`, carrying `source`'s refusal reason when it has one. */
export function withLaunchReason<E extends Error>(target: E, source: unknown): E {
  const reason = launchReasonOf(source);
  if (reason) (target as WithReason).reason = reason;
  return target;
}

/** The suite on MCPJam, opened to its run review as its Run button does. */
export function suiteOnMcpjamUrl(suiteId: string): string {
  return `${MCPJAM_HOSTED_APP_ORIGIN}${buildEvaluateSuiteRunPath(suiteId)}`;
}
