/**
 * Turn a run's COMMITTED skill pins into the two frozen-skill channels the
 * runner consumes. Shared by suite runs and their replays (pins frozen on the
 * run snapshot), environment quick runs (pins frozen on each committed
 * iteration) and swarm targets (pins frozen on the swarm's snapshot), so the
 * surfaces cannot drift in how a pin becomes a skill.
 *
 * Strict throughout — every failure throws before any model call:
 *   - a pinned supporting file whose blob is unreachable fails, attributed to
 *     the skill and the path (`url: null` is an unreachable blob, never "no
 *     file");
 *   - the harness shape downloads those same files, here in preparation rather
 *     than per iteration.
 *
 * An EMPTY pin set is a real answer and stays empty: `pinnedHarnessSkills` is
 * `[]` (the harness selects its pinned source by presence, and `undefined`
 * would fall through to a live project-wide fetch), and `pinnedSkillSource`
 * holds no pins, which plans every iteration with no skills.
 */
import type { PinnedSkillArtifact } from "@/shared/skill-types";
import type { RunPluginServer } from "../plugins/run-plugin-servers.js";
import {
  resolveTurnSkills,
  toSkillsAtTurn,
  turnRuntime,
  type PinnedSkillSource,
  type TurnSkills,
} from "../environments/turn-skills.js";
import { runPinnedSkillsToHarnessArtifacts } from "./run-pinned-harness-skills.js";
import {
  assertPinnedSkillFilesReachable,
  buildRunCapabilitySet,
  type RunPinnedPluginVersion,
  type RunPinnedSkill,
} from "./run-plugin-snapshot.js";

export type BuiltPinnedSkillSource = {
  pinnedSkillSource: PinnedSkillSource;
  pinnedHarnessSkills: PinnedSkillArtifact[];
};

export async function buildPinnedSkillSource(args: {
  /** The committed pins, content joined. `[]` means "delivers no skills". */
  pins: readonly RunPinnedSkill[];
  /**
   * The copies a harness writes to its box, one per pin in pin order, when the
   * caller fetched them itself: a swarm target's, which the swarm runner
   * fetches and caches by content. Absent: built from the pins here, with
   * every supporting file downloaded.
   */
  harnessSkills?: readonly PinnedSkillArtifact[];
  /**
   * The plugin versions the commit recorded — the snapshot's own record, never
   * re-resolved to a plugin's active version.
   */
  pluginVersions: readonly RunPinnedPluginVersion[];
  /** D2's verified plugin servers for THIS execution. */
  pluginServers: readonly RunPluginServer[];
  /** The server set the execution connected, in connection order. */
  effectiveServerIds: readonly string[];
  /** Display names index-aligned with `effectiveServerIds`; may be empty. */
  serverNames?: readonly string[];
}): Promise<BuiltPinnedSkillSource> {
  assertPinnedSkillFilesReachable(args.pins);
  const pinnedHarnessSkills = args.harnessSkills
    ? [...args.harnessSkills]
    : await runPinnedSkillsToHarnessArtifacts(args.pins);
  return {
    pinnedHarnessSkills,
    pinnedSkillSource: {
      kind: "pins",
      pins: args.pins,
      set: buildRunCapabilitySet({
        pins: args.pins,
        // Pinned files are read from the bytes downloaded above, not from the
        // prepared links, which a long run can outlast.
        downloadedPins: pinnedHarnessSkills,
        pluginVersions: args.pluginVersions,
        pluginServers: args.pluginServers,
        effectiveServerIds: args.effectiveServerIds,
        ...(args.serverNames ? { serverNames: args.serverNames } : {}),
      }),
      harnessSkills: pinnedHarnessSkills,
    },
  };
}

/**
 * One eval iteration's skills: the plan for the engine it runs on, and the
 * `skillsAtTurn` rows its turns record. Both iteration runners ask here, so a
 * harness iteration can never be handed its run's pins as agent tools as well
 * as on its box.
 *
 * A run that froze its skills records them on every turn, as `[]` when it
 * froze none (a suite without skills, or the without-skills arm of an A/B
 * run): those turns did run with none. An iteration with no frozen set to go
 * by (a quick run without an environment) records nothing, since `[]` would
 * claim it ran with none.
 */
export function iterationTurnSkills(args: {
  pinnedSkillSource?: PinnedSkillSource;
  /** The iteration's resolved client config. */
  execution: { agentLoop?: string; harness?: string };
  modelContextTokens?: number;
}): { skills: TurnSkills; skillsAtTurn?: Array<Record<string, unknown>> } {
  const skills = resolveTurnSkills({
    source: args.pinnedSkillSource ?? { kind: "none" },
    runtime: turnRuntime(args.execution),
    ...(args.modelContextTokens !== undefined
      ? { modelContextTokens: args.modelContextTokens }
      : {}),
  });
  return args.pinnedSkillSource
    ? { skills, skillsAtTurn: toSkillsAtTurn(skills) }
    : { skills };
}
