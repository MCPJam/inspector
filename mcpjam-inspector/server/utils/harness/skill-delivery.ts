/**
 * Which skill set a harness turn delivers — the single tri-state decision.
 *
 * Three callers can each be authoritative about a turn's skills, and they are
 * NOT interchangeable, so the precedence is written down once here instead of
 * being re-derived inside `runHarnessTurn`:
 *
 *   1. `pinned` — eval / swarm runs supply frozen `PinnedSkillArtifact`s from a
 *      run snapshot. Reproducibility outranks everything: a pinned run must be
 *      byte-identical on re-execution, so nothing live may be consulted.
 *   2. `environment` — a Project Environment turn supplies the artifacts its
 *      revision resolved to, in ONE atomic read. Live in the sense that the next
 *      turn re-resolves, but authoritative for THIS turn.
 *   3. `live` — the legacy project-wide fetch. Only when neither of the above
 *      spoke.
 *
 * PRESENCE, not length, selects a source in both overriding cases. An EMPTY
 * environment override is a real answer ("this environment delivers no skills")
 * and must skip the project-wide fetch: falling through would silently deliver
 * the whole project pool to a turn whose environment deliberately pinned none.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { pinnedArtifactsToRuntimeSkills } from "./pinned-harness-skills.js";
import type { RuntimeSkill } from "./runtime-skills.js";

export type HarnessSkillSource =
  | { mode: "pinned"; skills: RuntimeSkill[] }
  | { mode: "environment"; skills: RuntimeSkill[] }
  | { mode: "live" };

export function selectHarnessSkillSource(args: {
  /** Frozen run artifacts (eval / swarm). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /** Resolved Project Environment artifacts for this turn. */
  runtimeSkillsOverride?: RuntimeSkill[];
}): HarnessSkillSource {
  if (args.pinnedHarnessSkills !== undefined) {
    return {
      mode: "pinned",
      skills: pinnedArtifactsToRuntimeSkills(args.pinnedHarnessSkills),
    };
  }
  if (args.runtimeSkillsOverride !== undefined) {
    return { mode: "environment", skills: args.runtimeSkillsOverride };
  }
  return { mode: "live" };
}
