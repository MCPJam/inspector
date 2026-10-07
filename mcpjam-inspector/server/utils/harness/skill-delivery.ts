/**
 * Which skill set a harness turn delivers — one decision, made here.
 *
 * Several callers can each be authoritative about a turn's skills, and they are
 * NOT interchangeable, so the precedence is written down once here instead of
 * being re-derived inside `runHarnessTurn`:
 *
 *   1. `pinned` — eval / swarm runs supply frozen `PinnedSkillArtifact`s from a
 *      run snapshot. Reproducibility outranks everything: a pinned run must be
 *      byte-identical on re-execution, so nothing live may be consulted.
 *   2. `environment` — a Project Environment turn supplies the artifacts its
 *      revision resolved to, in ONE atomic read. Live in the sense that the next
 *      turn re-resolves, but authoritative for THIS turn.
 *   3. `live_plus` — a LIVE host turn that also runs the project's active
 *      plugins: the project-wide fetch, PLUS the plugins' skills. Selected only
 *      by the explicit `livePlugins` input, never inferred from an
 *      `EffectiveCapabilitySet` being present (that set is an environment's,
 *      and treating it as the turn's whole skill set would deliver plugin
 *      skills alone and prune every standalone skill's files).
 *   4. `live` — the legacy project-wide fetch. Only when none of the above
 *      spoke.
 *
 * PRESENCE, not length, selects a source in both overriding cases. An EMPTY
 * environment override is a real answer ("this environment delivers no skills")
 * and must skip the project-wide fetch: falling through would silently deliver
 * the whole project pool to a turn whose environment deliberately pinned none.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import type { EffectiveCapabilitySet } from "../../services/environments/effective-capabilities.js";
import { pinnedArtifactsToRuntimeSkills } from "./pinned-harness-skills.js";
import { withoutPluginVersions } from "./plugin-delivery.js";
import type { RuntimeSkill } from "./runtime-skills.js";

/**
 * A live host turn's active plugins, as the harness needs them.
 *
 * `skills` is the flat list the adapter writes to disk (name, description,
 * content, frontmatter); `capabilities` is the plugin-only capability set,
 * which carries what the flat list cannot: supporting files with signed URLs,
 * each server's and skill's plugin origin, and the versions that ran.
 */
export interface LivePluginDelivery {
  skills: RuntimeSkill[];
  capabilities: EffectiveCapabilitySet;
}

export type HarnessSkillSource =
  | { mode: "pinned"; skills: RuntimeSkill[] }
  | { mode: "environment"; skills: RuntimeSkill[] }
  | { mode: "live_plus"; plugins: LivePluginDelivery }
  | { mode: "live" };

export function selectHarnessSkillSource(args: {
  /** Frozen run artifacts (eval / swarm). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /** Resolved Project Environment artifacts for this turn. */
  runtimeSkillsOverride?: RuntimeSkill[];
  /** A live host turn's active plugins. */
  livePlugins?: LivePluginDelivery;
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
  if (args.livePlugins !== undefined) {
    return { mode: "live_plus", plugins: args.livePlugins };
  }
  return { mode: "live" };
}

/** A plugin skill left out of a `live_plus` delivery, and why. */
export interface LivePlusSkillProblem {
  code: "skill_folder_collision";
  skillId: string;
  /** The box folder name two skills wanted. */
  name: string;
}

/**
 * The skill list a `live_plus` turn delivers: the project's standalone skills,
 * then the plugins' skills, one per box folder.
 *
 * `live` is the project-wide fetch's result, `null` when that fetch FAILED. A
 * failed fetch makes the whole set unknown, so the answer is `null` too: the
 * caller then delivers nothing new and must not reconcile, because a reconcile
 * against the plugin skills alone would delete every standalone skill folder.
 *
 * Box folders are keyed by the bare name (a plugin skill materializes under its
 * declared name, not its `<plugin>/<skill>` ref), so a plugin skill whose name
 * a standalone skill — or an earlier plugin — already holds is dropped with a
 * problem rather than overwriting that folder.
 */
export function composeLivePlusSkills(
  live: RuntimeSkill[] | null,
  plugins: LivePluginDelivery,
): {
  skills: RuntimeSkill[] | null;
  pluginSkillIds: Set<string>;
  problems: LivePlusSkillProblem[];
} {
  if (live === null) {
    return { skills: null, pluginSkillIds: new Set(), problems: [] };
  }
  const usedNames = new Set(live.map((skill) => skill.name));
  const pluginSkillIds = new Set<string>();
  const problems: LivePlusSkillProblem[] = [];
  const skills = [...live];
  for (const skill of plugins.skills) {
    if (usedNames.has(skill.name)) {
      problems.push({
        code: "skill_folder_collision",
        skillId: skill.skillId,
        name: skill.name,
      });
      continue;
    }
    usedNames.add(skill.name);
    pluginSkillIds.add(skill.skillId);
    skills.push(skill);
  }
  return { skills, pluginSkillIds, problems };
}

/**
 * The same live plugins without some versions — used when server delivery had
 * to skip a plugin, so its skills do not reach the box without its tools.
 */
export function withoutLivePluginVersions(
  plugins: LivePluginDelivery,
  pluginVersionIds: ReadonlySet<string>,
): LivePluginDelivery {
  if (pluginVersionIds.size === 0) return plugins;
  const droppedSkillIds = new Set(
    plugins.capabilities.pluginSkills
      .filter(
        (skill) =>
          skill.plugin !== undefined &&
          pluginVersionIds.has(skill.plugin.pluginVersionId),
      )
      .map((skill) => skill.skillId),
  );
  return {
    skills: plugins.skills.filter(
      (skill) => !droppedSkillIds.has(skill.skillId),
    ),
    capabilities: withoutPluginVersions(plugins.capabilities, pluginVersionIds),
  };
}
