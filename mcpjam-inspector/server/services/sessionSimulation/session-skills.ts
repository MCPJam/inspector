/**
 * A swarm session's skills, planned with `resolveTurnSkills` like an eval
 * iteration's.
 *
 * A target that pinned its skills is prepared once, before its first session,
 * by the code that prepares an eval run's pins, so MCPJam's agent addresses
 * them by the same refs: `<plugin>/<skill>` for a plugin's skill, and
 * `<server>/<skill>` for a captured server skill, which loads with its origin
 * banner. An older target pinned nothing and reads the project's skills live.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import type { EffectiveCapabilitySet } from "../environments/effective-capabilities.js";
import {
  resolveTurnSkills,
  toSkillsAtTurn,
  turnRuntime,
  type PinnedSkillSource,
  type TurnSkills,
} from "../environments/turn-skills.js";
import { buildPinnedSkillSource } from "../evals/pinned-skill-source.js";
import type { RunPinnedPluginVersion } from "../evals/run-plugin-snapshot.js";
import type { PinnedSkillMeta } from "../swarm-agent.js";

/** One pinned row of a target and the body the swarm runner fetched for it. */
export interface FetchedTargetSkill {
  row: PinnedSkillMeta;
  /** As fetched: also the copy a harness writes to its box. */
  copy: PinnedSkillArtifact;
}

/**
 * A swarm target's frozen skills, from its pinned rows and their fetched
 * bodies, in pin order. Its sessions plan every turn from it.
 *
 * Supporting files are not in it: the rows list none, and the fetch serves
 * them as short-lived links this runner does not download, so MCPJam's agent
 * and the box both get each skill's SKILL.md alone.
 */
export async function buildTargetSkillSource(args: {
  skills: readonly FetchedTargetSkill[];
  pluginVersions: readonly RunPinnedPluginVersion[];
  /** The target's servers, for the set's server list. */
  serverIds: readonly string[];
}): Promise<PinnedSkillSource> {
  const built = await buildPinnedSkillSource({
    pins: args.skills.map(({ row, copy }) => ({
      ...row,
      content: copy.content,
    })),
    harnessSkills: args.skills.map(({ copy }) => copy),
    pluginVersions: args.pluginVersions,
    // A plugin skill's ref comes from the versions alone; its servers are
    // re-gated when the session connects them.
    pluginServers: [],
    effectiveServerIds: args.serverIds,
  });
  return built.pinnedSkillSource;
}

/**
 * One session's skill plan, shared by its turns, and the `skillsAtTurn` rows
 * each turn records.
 */
export function sessionTurnSkills(args: {
  /** The target's frozen skills; absent for an older target, which pinned none. */
  pinnedSkillSource?: PinnedSkillSource;
  /** The project's skills now, for an older target; absent when it gets none. */
  liveSkills?: EffectiveCapabilitySet;
  /** The harness the session runs on; absent for MCPJam's agent. */
  harness?: string;
  requireToolApproval: boolean;
  modelContextTokens?: number;
}): { skills: TurnSkills; skillsAtTurn?: Array<Record<string, unknown>> } {
  const runtime = turnRuntime({ harness: args.harness });
  // With approval on, MCPJam's agent gets none of the session's skills: a
  // headless visitor can't approve, and the local-runtime path refuses any
  // tool at all while approval is on. A harness's box is not gated by it.
  const withheld = args.requireToolApproval && runtime.kind === "agent";
  const skills = resolveTurnSkills({
    source: withheld
      ? { kind: "none" }
      : (args.pinnedSkillSource ??
        (args.liveSkills
          ? { kind: "live", set: args.liveSkills }
          : { kind: "none" })),
    runtime,
    ...(args.modelContextTokens !== undefined
      ? { modelContextTokens: args.modelContextTokens }
      : {}),
  });
  // Rows only for a target that froze its skills: a live set carries none, and
  // an empty list would claim the turn ran with no skills.
  return args.pinnedSkillSource
    ? { skills, skillsAtTurn: toSkillsAtTurn(skills) }
    : { skills };
}
