/**
 * Turn a run's COMMITTED skill pins into the two frozen-skill channels the
 * runner consumes. Shared by suite runs (pins frozen on the run snapshot) and
 * environment quick runs (pins frozen on each committed iteration), so the two
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
 * would fall through to a live project-wide fetch), and `pinnedSkillSource` is
 * absent, which every iteration runner reads as `{ kind: "none" }`.
 */
import type { PinnedSkillArtifact } from "@/shared/skill-types";
import type { EvalPinnedSkillSource } from "../evals-runner.js";
import type { RunPluginServer } from "../plugins/run-plugin-servers.js";
import { runPinnedSkillsToHarnessArtifacts } from "./run-pinned-harness-skills.js";
import {
  assertPinnedSkillFilesReachable,
  buildRunCapabilitySet,
  runNeedsEffectiveSkillSurface,
  type RunPinnedPluginVersion,
  type RunPinnedSkill,
} from "./run-plugin-snapshot.js";

export type BuiltPinnedSkillSource = {
  pinnedSkillSource?: EvalPinnedSkillSource;
  pinnedHarnessSkills: PinnedSkillArtifact[];
};

export async function buildPinnedSkillSource(args: {
  /** The committed pins, content joined. `[]` means "delivers no skills". */
  pins: readonly RunPinnedSkill[];
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
  const pinnedHarnessSkills = await runPinnedSkillsToHarnessArtifacts(
    args.pins,
  );
  if (args.pins.length === 0) return { pinnedHarnessSkills };
  return {
    pinnedHarnessSkills,
    pinnedSkillSource: runNeedsEffectiveSkillSurface(args.pins)
      ? {
          kind: "pinned-effective",
          capabilities: buildRunCapabilitySet({
            pins: args.pins,
            // Pinned files are read from the bytes downloaded above, not
            // from the prepared links, which a long run can outlast.
            downloadedPins: pinnedHarnessSkills,
            pluginVersions: args.pluginVersions,
            pluginServers: args.pluginServers,
            effectiveServerIds: args.effectiveServerIds,
            ...(args.serverNames ? { serverNames: args.serverNames } : {}),
          }),
        }
      : { kind: "pinned", skills: [...args.pins] },
  };
}
