/**
 * The skill inputs a harness turn takes from its caller, passed on to the
 * runner as they came: the plan, which says what the box gets, and the
 * capability set, which says which plugins ride along.
 */
import type { MCPJamHandlerOptions } from "../mcpjam-stream-handler.js";

type HarnessSkillOptions = Pick<
  MCPJamHandlerOptions,
  | "skillPlan"
  | "effectiveCapabilities"
>;

export function harnessSkillOptions(
  opts: HarnessSkillOptions,
): HarnessSkillOptions {
  return {
    ...(opts.skillPlan ? { skillPlan: opts.skillPlan } : {}),
    ...(opts.effectiveCapabilities
      ? { effectiveCapabilities: opts.effectiveCapabilities }
      : {}),
  };
}
