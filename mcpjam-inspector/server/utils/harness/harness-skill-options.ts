/**
 * The skill inputs a harness turn takes from its caller, passed on to the
 * runner as they came. Presence is semantic: an empty list is a real answer (a
 * frozen run that delivers no skills clears the box), and an absent one leaves
 * the box as it is. The plan, when a caller sends one, wins over a run's copies;
 * the swarm runner still sends copies.
 */
import type { MCPJamHandlerOptions } from "../mcpjam-stream-handler.js";

type HarnessSkillOptions = Pick<
  MCPJamHandlerOptions,
  | "skillPlan"
  | "pinnedHarnessSkills"
  | "effectiveCapabilities"
>;

export function harnessSkillOptions(
  opts: HarnessSkillOptions,
): HarnessSkillOptions {
  return {
    ...(opts.skillPlan ? { skillPlan: opts.skillPlan } : {}),
    ...(opts.pinnedHarnessSkills !== undefined
      ? { pinnedHarnessSkills: opts.pinnedHarnessSkills }
      : {}),
    ...(opts.effectiveCapabilities
      ? { effectiveCapabilities: opts.effectiveCapabilities }
      : {}),
  };
}
