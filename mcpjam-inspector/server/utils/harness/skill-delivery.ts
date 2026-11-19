/**
 * What the runner reads of a harness turn's skill plan: the skills in the
 * turn's order, their supporting files, and the fingerprint that forks a
 * resumable session. The plan decides all of it (`TurnSkills.harness`); nothing
 * here chooses a source.
 *
 * PRESENCE, not length, is what the plan carries. An EMPTY list is a real answer
 * ("this turn delivers no skills"), and the box writer clears MCPJam's folders
 * for it. A turn with no plan, or a plan that read no skills, is unknown, never
 * empty, and leaves the box exactly as it is.
 */
import type { TurnSkills } from "../../services/environments/turn-skills.js";
import type { HarnessSkillMode } from "../../services/environments/harness-skill-delivery.js";
import type { BoxSkillFiles } from "./box-skills-writer.js";
import { skillsFingerprint, type RuntimeSkill } from "./runtime-skills.js";

/** A turn's skills for its box, read from its plan. */
export interface HarnessTurnSkills {
  mode: HarnessSkillMode;
  /** In the turn's order; `null` when the turn named no source, which leaves
   *  the box exactly as it is. */
  skills: RuntimeSkill[] | null;
  /** Folded into the session lane so a skill change forks the session;
   *  `undefined` when the skills are unknown, so the stored hash stands. */
  skillsHash: string | undefined;
  /** The skills' supporting files, read when the writer needs them. */
  readFiles(): Promise<BoxSkillFiles>;
  /** A live turn: its servers are connected now, so their own skills may be
   *  offered. Never a run's copies, which froze their own. */
  live: boolean;
}

const NO_FILES_KNOWN: BoxSkillFiles = { files: [], complete: () => false };

/**
 * A turn's skills as its plan prepared them for this runtime. The plan was made
 * for one runtime, so a plan for another is a wiring bug, and it fails here
 * rather than writing the wrong skills to a box. No plan is a turn that named no
 * source.
 */
export function harnessTurnSkillsFromPlan(
  plan: TurnSkills | undefined,
  harnessId: string,
): HarnessTurnSkills {
  if (
    plan &&
    (plan.runtime.kind !== "harness" || plan.runtime.harnessId !== harnessId)
  ) {
    throw new Error(
      `This turn's skill plan was made for ${
        plan.runtime.kind === "harness" ? plan.runtime.harnessId : "MCPJam's agent"
      }, but ${harnessId} is running it.`,
    );
  }
  const delivery = plan?.harness;
  if (!delivery || delivery.skills === null) {
    return {
      mode: "none",
      skills: null,
      skillsHash: undefined,
      readFiles: async () => NO_FILES_KNOWN,
      live: delivery?.live ?? false,
    };
  }
  const { files } = delivery;
  return {
    mode: delivery.mode,
    skills: delivery.skills,
    skillsHash: skillsFingerprint(delivery.skills),
    readFiles: async () =>
      files ? { files, complete: () => true } : NO_FILES_KNOWN,
    live: delivery.live,
  };
}
