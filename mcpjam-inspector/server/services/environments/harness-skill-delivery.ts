/**
 * What a harness turn executes of its skill plan: the box writer's input for
 * the runtime that runs the turn, decided once with the plan's verdicts
 * (`boxVerdicts`) rather than rebuilt from the turn's raw inputs.
 *
 * The runner used to choose the source again: a run's frozen copies, else the
 * environment's skills, else nothing. That second choice had to agree with the
 * plan by hand, and a caller that forwarded one without the other left a box
 * running skills the plan did not describe.
 */
import type { BoxSkillFile } from "../../utils/harness/materialize-skill-files.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";

/**
 * Which source speaks for the turn. `pinned`: a run's frozen copies, which
 * outrank everything because nothing live may be consulted for a run that must
 * reproduce. `environment`: the skills its environment resolved to, in one
 * read. `none`: the turn named no source, so its skills are unknown, never
 * empty, and the box stays exactly as it is.
 */
export type HarnessSkillMode = "pinned" | "environment" | "none";

export interface HarnessSkillDelivery {
  mode: HarnessSkillMode;
  /**
   * What the box writer plans from, in the turn's order. A captured MCP-server
   * skill's plain copy is absent when the runtime takes server skills through
   * MCPJam's tools. `null` for `none`; an empty list is a real answer, and the
   * writer clears MCPJam's folders for it.
   */
  skills: RuntimeSkill[] | null;
  /**
   * The skills' supporting files. `null` when the turn could not read them, so
   * the box keeps each skill's other files rather than pruning them.
   */
  files: BoxSkillFile[] | null;
  /**
   * A live turn: its servers are connected now, so their own skills may be
   * offered. Never a run's frozen copies, which took nothing live.
   */
  live: boolean;
}

/** A turn that named no source: the box stays as it is. */
export function unnamedSkills(live = false): HarnessSkillDelivery {
  return { mode: "none", skills: null, files: null, live };
}
