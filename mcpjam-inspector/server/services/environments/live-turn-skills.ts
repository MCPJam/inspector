/**
 * A live surface's turn skills, planned in one place for the Playground, User
 * Testing and chat over the API: the plan `resolveTurnSkills` makes for the
 * engine that runs the turn, what a harness turn hands its box writer, and the
 * record the turn writes from that same plan.
 *
 * Every live turn plans from the environment it resolved. A Playground
 * client's own skills come inside that environment (`skillScope: 'visible'`),
 * so no surface reads a project's pool beside it. A study whose scenario
 * predates environments has none, and reads its shared Library instead
 * ({@link studyLibraryTurnSkills}).
 */
import type { ExecutionScope } from "../../utils/execution-scope.js";
import {
  fetchRuntimeSkillFiles,
  fetchRuntimeSkills,
} from "../../utils/harness/runtime-skills.js";
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
  /**
   * The turn's plan. MCPJam's agent serves it through its skill tools
   * (`prepareChatV2`), and a harness turn carries it out (`skillPlan`), live
   * servers' own skills included: the plan says whether the turn is live.
   */
  skills: TurnSkills;
  /**
   * The environment's capability set, which a harness turn reads for its
   * plugins' origins and versions. Absent when the turn read no environment, or
   * when a study's skill files could not be read.
   */
  capabilities?: EffectiveCapabilitySet;
  /** The environment's own skills, for the turn's telemetry. */
  environmentSkillCount: number;
  /** A study whose shared Library could not be read ran with unknown skills. */
  skillsUnread?: true;
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
  /** The skills' supporting files could not be read: a harness box keeps each
   *  skill's other files, and the plan says so. */
  filesUnread?: boolean;
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
      ...(args.filesUnread ? { filesUnread: true } : {}),
    },
    runtime: args.runtime,
    ...(args.modelContextTokens !== undefined
      ? { modelContextTokens: args.modelContextTokens }
      : {}),
  });
  const turnProvenance = turnSkillProvenance(args.spec.environmentRef, skills);
  return {
    skills,
    ...(args.filesUnread ? {} : { capabilities: skills.set }),
    environmentSkillCount: runtimeSkills(args.spec).length,
    ...(turnProvenance ? { turnProvenance } : {}),
  };
}

/**
 * A turn in a study whose scenario predates environments. It reads the
 * study's shared Library through the study's own scope, where the backend
 * returns shared skills only, to every tester, members included. The read is
 * planned like an environment's skills, for both engines, and the turn stays
 * live: the study's servers are connected now, so their own skills join. The
 * turn names no environment, so it writes no record.
 *
 * A failed read loses the Library's skills, never the servers' own, and
 * leaves a harness's box as it is, so a backend hiccup never deletes the
 * folders an earlier turn wrote.
 */
export async function studyLibraryTurnSkills(args: {
  bearer: string;
  projectId: string;
  executionScope?: ExecutionScope;
  runtime: TurnRuntime;
  modelContextTokens?: number;
}): Promise<LiveTurnSkills> {
  const [read, files] = await Promise.all([
    fetchRuntimeSkills(args.bearer, args.projectId, args.executionScope),
    fetchRuntimeSkillFiles(args.bearer, args.projectId, args.executionScope),
  ]);
  if (!read.ok) {
    return {
      skills: resolveTurnSkills({
        source: { kind: "live", projectSkills: [] },
        runtime: args.runtime,
      }),
      environmentSkillCount: 0,
      skillsUnread: true,
    };
  }
  const filesOf = (skillId: string) =>
    files.ok
      ? files.files.flatMap((file) =>
          file.skillId === skillId
            ? [{ path: file.path, size: file.size, url: file.url }]
            : [],
        )
      : [];
  const spec: TurnEnvironment = {
    servers: { effectiveServerIds: [] },
    skills: read.skills.map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      aggregateHash: skill.aggregateHash,
      ...(skill.extraFrontmatter
        ? { extraFrontmatter: skill.extraFrontmatter }
        : {}),
      channels: [],
      files: filesOf(skill.skillId),
    })),
  };
  // Files unknown: the box writes each SKILL.md and keeps its other files.
  return environmentTurnSkills({
    spec,
    attribution: null,
    liveExtras: {},
    ...(files.ok ? {} : { filesUnread: true }),
    runtime: args.runtime,
    ...(args.modelContextTokens !== undefined
      ? { modelContextTokens: args.modelContextTokens }
      : {}),
  });
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
