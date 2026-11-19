/**
 * The skill inputs a harness turn takes from its caller, passed on to the
 * runner as they came. Presence is semantic for each: an empty list is a real
 * answer (a frozen run or environment that delivers no skills clears the box),
 * and an absent one leaves the box as it is. The plan, when a caller sends one,
 * wins over the older inputs; each caller moves onto it in turn.
 */
import type { MCPJamHandlerOptions } from "../mcpjam-stream-handler.js";

type HarnessSkillOptions = Pick<
  MCPJamHandlerOptions,
  | "skillPlan"
  | "pinnedHarnessSkills"
  | "runtimeSkillsOverride"
  | "effectiveCapabilities"
  | "liveTurn"
>;

export function harnessSkillOptions(
  opts: HarnessSkillOptions,
): HarnessSkillOptions {
  return {
    ...(opts.skillPlan ? { skillPlan: opts.skillPlan } : {}),
    ...(opts.pinnedHarnessSkills !== undefined
      ? { pinnedHarnessSkills: opts.pinnedHarnessSkills }
      : {}),
    ...(opts.runtimeSkillsOverride !== undefined
      ? { runtimeSkillsOverride: opts.runtimeSkillsOverride }
      : {}),
    ...(opts.effectiveCapabilities
      ? { effectiveCapabilities: opts.effectiveCapabilities }
      : {}),
    ...(opts.liveTurn ? { liveTurn: true } : {}),
  };
}
