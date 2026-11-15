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
import type { PinnedSkillArtifactFile } from "../../../shared/skill-types.js";
import type { RuntimeStandaloneSkill } from "../environments/effective-capabilities.js";
import type { LiveSkillSource } from "../environments/turn-skill-sources.js";
import {
  resolveTurnSkills,
  toSkillsAtTurn,
  turnRuntime,
  type PinnedSkillSource,
  type TurnSkills,
} from "../environments/turn-skills.js";
import { buildPinnedSkillSource } from "../evals/pinned-skill-source.js";
import { runPinnedSkillsToHarnessArtifacts } from "../evals/run-pinned-harness-skills.js";
import type { RunPinnedPluginVersion } from "../evals/run-plugin-snapshot.js";
import type { FetchedPinnedSkill, PinnedSkillMeta } from "../swarm-agent.js";

/** One pinned row of a target and the body the swarm runner fetched for it. */
export interface FetchedTargetSkill {
  row: PinnedSkillMeta;
  copy: FetchedPinnedSkill;
}

/**
 * A swarm target's frozen skills, from its pinned rows and their fetched
 * bodies, in pin order. Its sessions plan every turn from it.
 *
 * Resolve supporting files before sessions start so their signed links can
 * expire without affecting the turn.
 */
export async function buildTargetSkillSource(args: {
  skills: readonly FetchedTargetSkill[];
  pluginVersions: readonly RunPinnedPluginVersion[];
  /** The target's servers, for the set's server list. */
  serverIds: readonly string[];
  signal?: AbortSignal;
}): Promise<PinnedSkillSource> {
  const pins = args.skills.map(({ row, copy }) => {
    const files = copy.files?.filter((file) => "url" in file);
    return {
      ...row,
      content: copy.content,
      ...(files?.length ? { files } : {}),
    };
  });
  const downloaded = await runPinnedSkillsToHarnessArtifacts(pins, {
    signal: args.signal,
  });
  const built = await buildPinnedSkillSource({
    pins,
    harnessSkills: args.skills.map(({ copy }, index) => {
      const { files, extraFrontmatter, ...artifact } = copy;
      const inline = files?.filter((file): file is PinnedSkillArtifactFile => !("url" in file)) ?? [];
      const supportingFiles = [...inline, ...(downloaded[index]?.files ?? [])];
      return {
        ...artifact,
        contentHash: pins[index]?.aggregateHash ?? artifact.contentHash,
        ...(extraFrontmatter ? { frontmatter: extraFrontmatter } : {}),
        ...(supportingFiles.length ? { files: supportingFiles } : {}),
      };
    }),
    pluginVersions: args.pluginVersions,
    // A plugin skill's ref comes from the versions alone; its servers are
    // re-gated when the session connects them.
    pluginServers: [],
    effectiveServerIds: args.serverIds,
    reportsFailure: false,
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
  liveSkills?: readonly RuntimeStandaloneSkill[];
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
  // An older target's live skills are for MCPJam's agent alone: a harness's
  // box fetches the project's skills itself, which this plan does not see.
  const live: LiveSkillSource | undefined =
    args.liveSkills && runtime.kind === "agent"
      ? { kind: "live", projectSkills: args.liveSkills }
      : undefined;
  const skills = resolveTurnSkills({
    source: withheld
      ? { kind: "none" }
      : (args.pinnedSkillSource ?? live ?? { kind: "none" }),
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
