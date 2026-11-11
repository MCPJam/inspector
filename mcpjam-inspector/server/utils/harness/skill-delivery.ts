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
 *   2. `live_plus` — the Playground's HIDDEN environment: a client turn that
 *      runs the project's plugins through an ad-hoc environment. It delivers
 *      the project-wide live fetch PLUS the environment's own skills, because
 *      the turn it stands in for (a plain client turn) delivers the project's
 *      pool. Selected only by the explicit `includeProjectSkills` input on top
 *      of an environment override — never inferred from an
 *      `EffectiveCapabilitySet` being present, which every environment turn
 *      carries.
 *   3. `environment` — a Project Environment turn supplies the artifacts its
 *      revision resolved to, in ONE atomic read. Live in the sense that the next
 *      turn re-resolves, but authoritative for THIS turn.
 *   4. `live` — the legacy project-wide fetch. Only when none of the above
 *      spoke.
 *
 * PRESENCE, not length, selects a source in both overriding cases. An EMPTY
 * environment override is a real answer ("this environment delivers no skills")
 * and must skip the project-wide fetch: falling through would silently deliver
 * the whole project pool to a turn whose environment deliberately pinned none.
 *
 * `harnessTurnSkills` reads the chosen source into what the box writer
 * (`box-skills-writer.ts`) takes: the skills in the turn's order, their
 * supporting files, and the fingerprint that forks a resumable session.
 */
import type { EffectiveCapabilitySet } from "../../services/environments/effective-capabilities.js";
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { logger } from "../logger.js";
import type { BoxSkillFiles } from "./box-skills-writer.js";
import { pinnedArtifactsToRuntimeSkills } from "./pinned-harness-skills.js";
import { capabilitySkillFiles, skillsHashWithPlugins } from "./plugin-delivery.js";
import {
  skillsFingerprint,
  type FetchRuntimeSkillFilesResult,
  type FetchRuntimeSkillsResult,
  type RuntimeSkill,
} from "./runtime-skills.js";

export type HarnessSkillSource =
  | { mode: "pinned"; skills: RuntimeSkill[] }
  | { mode: "environment"; skills: RuntimeSkill[] }
  /** The project-wide live fetch, plus these environment skills. */
  | { mode: "live_plus"; environmentSkills: RuntimeSkill[] }
  | { mode: "live" };

export function selectHarnessSkillSource(args: {
  /** Frozen run artifacts (eval / swarm). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /** Resolved Project Environment artifacts for this turn. */
  runtimeSkillsOverride?: RuntimeSkill[];
  /**
   * The Playground's hidden environment: deliver the project's live pool
   * beside the environment's own skills instead of in place of them.
   */
  includeProjectSkills?: boolean;
}): HarnessSkillSource {
  if (args.pinnedHarnessSkills !== undefined) {
    return {
      mode: "pinned",
      skills: pinnedArtifactsToRuntimeSkills(args.pinnedHarnessSkills),
    };
  }
  if (args.runtimeSkillsOverride !== undefined) {
    return args.includeProjectSkills === true
      ? { mode: "live_plus", environmentSkills: args.runtimeSkillsOverride }
      : { mode: "environment", skills: args.runtimeSkillsOverride };
  }
  return { mode: "live" };
}

/** A skill left out of a `live_plus` delivery, and why. */
export interface LivePlusSkillProblem {
  code: "skill_folder_collision";
  skillId: string;
  /** The box folder name two skills wanted. */
  name: string;
}

export interface LivePlusSkills {
  /** What the turn delivers; `null` when the project-wide fetch FAILED. */
  skills: RuntimeSkill[] | null;
  /** Delivered entries that are the environment's: their supporting files
   *  come from its capability set. */
  environmentSkillIds: Set<string>;
  /** Delivered entries added from the project's pool: their supporting files
   *  come from the project-wide file query. */
  projectSkillIds: Set<string>;
  problems: LivePlusSkillProblem[];
}

/**
 * The skill list a `live_plus` turn delivers: the environment's skills, then
 * the project's pool, one skill per box folder.
 *
 * `live` is the project-wide fetch's result, `null` when that fetch FAILED. A
 * failed fetch makes the whole set unknown, so the answer is `null` too: the
 * caller then delivers nothing new and must not reconcile, because a reconcile
 * against the environment's skills alone would delete every folder the
 * project's pool put on the box.
 *
 * A project skill the environment already carries (the client selected it, so
 * it arrived on the host channel) is the same skill and is not added twice.
 *
 * Box folders are keyed by the BARE name — a plugin skill materializes under
 * its declared name, not its `<plugin>/<skill>` ref — so two different skills
 * can want one folder. The environment's entry wins and the other is dropped
 * with a problem rather than overwriting that folder:
 *
 *   - it is the rule the emulated engine applies to this same turn
 *     (`withLiveProjectSkills` keeps the environment's entries);
 *   - a plugin arrives whole: the environment already delivers its servers,
 *     and its skill is usually what tells the model how to use them;
 *   - the environment's set is the same for every member, while the pool
 *     includes each member's personal skills, so one member's personal skill
 *     cannot change what a plugin delivers for that member alone.
 */
export function composeLivePlusSkills(
  live: RuntimeSkill[] | null,
  environmentSkills: RuntimeSkill[],
): LivePlusSkills {
  const environmentSkillIds = new Set<string>();
  const projectSkillIds = new Set<string>();
  if (live === null) {
    return {
      skills: null,
      environmentSkillIds,
      projectSkillIds,
      problems: [],
    };
  }
  const usedNames = new Set<string>();
  const seenSkillIds = new Set<string>();
  const problems: LivePlusSkillProblem[] = [];
  const skills: RuntimeSkill[] = [];
  const take = (skill: RuntimeSkill, into: Set<string>) => {
    if (seenSkillIds.has(skill.skillId)) return;
    seenSkillIds.add(skill.skillId);
    if (usedNames.has(skill.name)) {
      problems.push({
        code: "skill_folder_collision",
        skillId: skill.skillId,
        name: skill.name,
      });
      return;
    }
    usedNames.add(skill.name);
    into.add(skill.skillId);
    skills.push(skill);
  };
  for (const skill of environmentSkills) take(skill, environmentSkillIds);
  for (const skill of live) take(skill, projectSkillIds);
  return { skills, environmentSkillIds, projectSkillIds, problems };
}

/** A turn's skills for its box, read from the source that spoke. */
export interface HarnessTurnSkills {
  mode: HarnessSkillSource["mode"];
  /** In the turn's order; `null` when the project's skills could not be read,
   *  which leaves the box exactly as it is. */
  skills: RuntimeSkill[] | null;
  /** Folded into the session lane so a skill change forks the session;
   *  `undefined` when the skills are unknown, so the stored hash stands. */
  skillsHash: string | undefined;
  /** The skills' supporting files, read when the writer needs them. */
  readFiles(): Promise<BoxSkillFiles>;
}

const NO_FILES_KNOWN: BoxSkillFiles = { files: [], complete: () => false };

/**
 * Read a turn's skills from its source (`selectHarnessSkillSource`). Files come
 * from the same place as the skills: an environment's capability set carries
 * its skills' (the only source of a plugin skill's, which the project-wide
 * file query leaves out), and the project's pool is read with the project-wide
 * query, at write time and only when the box gets a skill. A run's frozen
 * copies carry theirs, which `materializePinnedSkillFiles` writes.
 */
export async function harnessTurnSkills(args: {
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  runtimeSkillsOverride?: RuntimeSkill[];
  includeProjectSkills?: boolean;
  effectiveCapabilities?: EffectiveCapabilitySet;
  /** The project's live skills and files; absent when the turn has no project
   *  to read, which delivers none from it. */
  project?: {
    skills(): Promise<FetchRuntimeSkillsResult>;
    files(): Promise<FetchRuntimeSkillFilesResult>;
  };
}): Promise<HarnessTurnSkills> {
  const source = selectHarnessSkillSource(args);
  const own = args.effectiveCapabilities
    ? capabilitySkillFiles(args.effectiveCapabilities)
    : undefined;
  const projectFiles = async (): Promise<BoxSkillFiles> => {
    const listing = await args.project?.files();
    return listing?.ok
      ? { files: listing.files, complete: () => true }
      : NO_FILES_KNOWN;
  };
  if (source.mode === "pinned" || source.mode === "environment") {
    return {
      mode: source.mode,
      skills: source.skills,
      skillsHash: skillsFingerprint(source.skills),
      readFiles:
        source.mode === "pinned"
          ? async () => NO_FILES_KNOWN
          : own
            ? async () => ({ files: own, complete: () => true })
            : projectFiles,
    };
  }
  const fetched = args.project
    ? await args.project.skills()
    : { ok: true as const, skills: [] };
  const live = fetched.ok ? fetched.skills : null;
  if (source.mode === "live") {
    return {
      mode: "live",
      skills: live,
      skillsHash: live ? skillsFingerprint(live) : undefined,
      readFiles: projectFiles,
    };
  }
  const composed = composeLivePlusSkills(live, source.environmentSkills);
  if (composed.problems.length > 0) {
    // Ids and codes only: a skill name is user-authored content.
    logger.warn("[harness] skills left out: box folder taken", {
      problems: composed.problems.map(({ code, skillId }) => ({ code, skillId })),
    });
  }
  return {
    mode: "live_plus",
    skills: composed.skills,
    // The set mixes the project's pool with plugin skills, so the plugin
    // versions that ran fold into its hash: a version change re-writes the
    // box's skills even when their text reads the same.
    skillsHash: composed.skills
      ? skillsHashWithPlugins(
          skillsFingerprint(composed.skills),
          args.effectiveCapabilities?.pluginVersions ?? [],
        )
      : undefined,
    // The environment's entries take their files from its capability set, the
    // pool's from the project-wide query. If that query fails, only the
    // environment's folders are touched: the pool's files stay as they are.
    readFiles: async () => {
      const pool =
        composed.projectSkillIds.size > 0 ? await projectFiles() : NO_FILES_KNOWN;
      return {
        files: [
          ...pool.files.filter((file) =>
            composed.projectSkillIds.has(file.skillId),
          ),
          ...(own ?? []).filter((file) =>
            composed.environmentSkillIds.has(file.skillId),
          ),
        ],
        complete: (skillId) =>
          composed.environmentSkillIds.has(skillId) ||
          (composed.projectSkillIds.has(skillId) && pool.complete(skillId)),
      };
    },
  };
}
