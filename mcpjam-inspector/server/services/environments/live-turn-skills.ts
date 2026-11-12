/**
 * A live surface's turn skills, planned in one place for the Playground, User
 * Testing and chat over the API: the plan `resolveTurnSkills` makes for the
 * engine that runs the turn, what a harness turn hands its box writer, and the
 * record the turn writes from that same plan.
 *
 * Every live turn plans from the environment it resolved. A Playground
 * client's own skills come inside that environment (`skillScope: 'visible'`),
 * so no surface reads a project's pool beside it.
 */
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import type {
  EffectiveCapabilityInput,
  EffectiveCapabilitySet,
} from "./effective-capabilities.js";
import type { PluginRuntimeAttribution } from "./plugin-attribution.js";
import {
  runtimeSkills,
  type ResolvedEnvironmentRuntime,
  type ResolvedEnvironmentSkill,
  type TurnSkillProvenance,
} from "./runtime.js";
import type { LiveSkillExtras } from "./turn-skill-sources.js";
import {
  resolveTurnSkills,
  toSkillsAtTurn,
  type TurnRuntime,
  type TurnSkills,
} from "./turn-skills.js";

export interface LiveTurnSkills {
  /** The turn's plan: `prepareChatV2` serves it to MCPJam's agent. */
  skills: TurnSkills;
  /**
   * What a harness turn writes to its box (`runtimeSkillsOverride`), and the
   * set that carries their supporting files (`effectiveCapabilities`). Absent
   * when the plan is not the box's source: a study whose scenario predates
   * environments has its harness read the study's skills itself.
   */
  box?: { skills: RuntimeSkill[]; set: EffectiveCapabilitySet };
  /** A live turn: its servers are connected now, so their own skills join the
   *  set (`liveTurn` on a harness). A named environment captured its own. */
  live: boolean;
  /** The turn record's environment and `skillsAtTurn`; absent when the turn
   *  has no environment to name. */
  turnProvenance?: TurnSkillProvenance;
}

/** The environment a turn resolved, after its own plugin narrowing. */
export type TurnEnvironment = EffectiveCapabilityInput &
  Partial<Pick<ResolvedEnvironmentRuntime, "environmentRef">>;

/**
 * A turn on a resolved environment. `liveExtras` marks a live turn, present
 * even when empty: its servers are connected now, so their own skills join
 * MCPJam's agent's set when its prompt is built. A named environment's turn
 * has none: its server skills were captured with it.
 */
export function environmentTurnSkills(args: {
  spec: TurnEnvironment;
  attribution: PluginRuntimeAttribution | null;
  /** Skills this turn's plugin narrowing switched off. */
  pluginDisabled?: readonly ResolvedEnvironmentSkill[];
  liveExtras?: LiveSkillExtras;
  runtime: TurnRuntime;
  modelContextTokens?: number;
}): LiveTurnSkills {
  const skills = resolveTurnSkills({
    source: {
      kind: "environment",
      spec: args.spec,
      attribution: args.attribution,
      ...(args.pluginDisabled?.length
        ? { pluginDisabled: args.pluginDisabled }
        : {}),
      ...(args.liveExtras ? { liveExtras: args.liveExtras } : {}),
    },
    runtime: args.runtime,
    ...(args.modelContextTokens !== undefined
      ? { modelContextTokens: args.modelContextTokens }
      : {}),
  });
  const turnProvenance = turnSkillProvenance(args.spec.environmentRef, skills);
  return {
    skills,
    box: { skills: runtimeSkills(args.spec), set: skills.set },
    live: args.liveExtras !== undefined,
    ...(turnProvenance ? { turnProvenance } : {}),
  };
}

/**
 * What a turn records about the configuration it ran with: its environment,
 * and the metadata row of every skill its plan hands the engine
 * (`toSkillsAtTurn`). The plan already says which skills reach which engine,
 * so the record and the delivery cannot disagree.
 *
 * `undefined` when there is no environment to record. An empty `skillsAtTurn`
 * means the turn ran with none, a different answer from "unknown". An
 * environment ref with an EMPTY name is not recorded: `readScenarioEnvironment`
 * reads a missing name as `""`, which an exported trace would show as a real
 * environment called nothing.
 */
export function turnSkillProvenance(
  environmentRef: ResolvedEnvironmentRuntime["environmentRef"] | undefined,
  skills: TurnSkills,
): TurnSkillProvenance | undefined {
  if (
    !environmentRef ||
    typeof environmentRef.environmentId !== "string" ||
    typeof environmentRef.name !== "string" ||
    environmentRef.name.length === 0 ||
    typeof environmentRef.revision !== "number"
  ) {
    return undefined;
  }
  return {
    environmentAtTurn: {
      environmentId: environmentRef.environmentId,
      name: environmentRef.name,
      revision: environmentRef.revision,
    },
    skillsAtTurn: toSkillsAtTurn(skills),
  };
}
