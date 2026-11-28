/**
 * Why the server refused an eval launch, kept on the Error the run sheet
 * catches, so the sheet can offer the fix that reason has.
 */
import { buildEvaluateSuiteRunPath } from "@/lib/app-navigation";
import { HOSTED_MODE } from "@/lib/config";
import { MCPJAM_HOSTED_APP_ORIGIN } from "@/lib/oauth/constants";
import {
  CODE_EVALUATORS_UNAVAILABLE,
  CODE_EVALUATOR_RULES_FOR_MCPJAM,
} from "@/shared/local-eval-venue";

type WithReason = Error & { reason?: string; rule?: string };

/** The same origin the server relays to; staging and self-hosted set both. */
const MCPJAM_ORIGIN =
  (import.meta.env.VITE_MCPJAM_HOSTED_ORIGIN as string | undefined)?.replace(/\/+$/, "") ||
  MCPJAM_HOSTED_APP_ORIGIN;

export function launchReasonOf(error: unknown): { reason?: string; rule?: string } {
  if (!(error instanceof Error)) return {};
  const { reason, rule } = error as WithReason;
  return {
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof rule === "string" ? { rule } : {}),
  };
}

/** `target`, carrying `source`'s refusal reason and rule when it has them. */
export function withLaunchReason<E extends Error>(target: E, source: unknown): E {
  Object.assign(target, launchReasonOf(source));
  return target;
}

/**
 * A refusal only MCPJam's own runners can lift: the suite's scripts or
 * Required code evaluators need eval sandboxes this Inspector can't start.
 * Grading rules are suite settings MCPJam refuses the same way, and the
 * hosted app is MCPJam, so neither gets a link.
 */
export function runsOnMcpjamInstead(error: unknown): boolean {
  const { reason, rule } = launchReasonOf(error);
  return !HOSTED_MODE && reason === CODE_EVALUATORS_UNAVAILABLE && CODE_EVALUATOR_RULES_FOR_MCPJAM.includes(rule ?? "");
}

/** The suite on MCPJam, opened to its run review as its Run button does. */
export function suiteOnMcpjamUrl(suiteId: string): string {
  return `${MCPJAM_ORIGIN}${buildEvaluateSuiteRunPath(suiteId)}`;
}
