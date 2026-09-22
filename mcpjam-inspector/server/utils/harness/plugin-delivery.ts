/**
 * Plugin delivery into a Computer harness turn (INS-7).
 *
 * The INS-3 `EffectiveCapabilitySet` already says WHAT a turn may reach; this
 * module turns that set into the two things the Claude Code / Computer delivery
 * path still needs and could not previously get:
 *
 *   1. {@link capabilitySkillFiles} — the supporting files of every skill the
 *      turn delivers, taken from the SAME atomic resolution that produced the
 *      skills. The harness path otherwise sources files from the project-wide
 *      `projectSkills:listSkillFilesForRuntime` query, which filters through
 *      `isStandaloneSkill` and therefore CANNOT return a plugin skill's files:
 *      a plugin skill reached the box as a bare SKILL.md with its `scripts/` and
 *      `references/` missing. The resolved spec carries them (signed URLs minted
 *      in the same read), so delivery consumes that instead of asking a second,
 *      differently-scoped source.
 *   2. {@link pluginVersionsFingerprint} — the resume-invalidating identity of
 *      the plugin runtime that was materialized into the sandbox.
 *
 * Nothing here re-resolves anything. Plugin availability, version choice and
 * skill composition were decided backend-side on THIS launch (and are decided
 * again on the next one); this module only projects that decision into delivery
 * inputs. Nothing here is persisted either: the fingerprint is a comparison
 * value for resume eligibility, not a pin — a recorded plugin version must never
 * be able to restore a plugin the environment no longer resolves.
 */
import type {
  EffectiveCapabilitySet,
  RuntimePluginVersion,
} from "../../services/environments/effective-capabilities.js";
import { allEffectiveSkills } from "../../services/environments/effective-capabilities.js";
import type { RuntimeSkillFile } from "./runtime-skills.js";

/**
 * Every delivered skill's supporting files, in the shape
 * `materializeSkillFiles` consumes (the existing Computer writer — same path
 * validation, same per-turn byte budget, same stale-file prune).
 *
 * Plugin skills come FIRST because {@link allEffectiveSkills} orders them so;
 * the writer is order-insensitive, but a stable order keeps logs comparable.
 *
 * A file with no signed `url` is still emitted: the writer skips it, and
 * dropping it here would instead make it look like a file that was REMOVED
 * upstream and get its on-box copy pruned.
 */
export function capabilitySkillFiles(
  set: EffectiveCapabilitySet
): RuntimeSkillFile[] {
  const files: RuntimeSkillFile[] = [];
  for (const skill of allEffectiveSkills(set)) {
    for (const file of skill.files) {
      files.push({
        skillId: skill.skillId,
        path: file.path,
        size: file.size,
        url: file.url,
      });
    }
  }
  return files;
}

/**
 * Deterministic fingerprint over the plugin runtime a turn materializes:
 * (version identity, bundle content) per pinned version, order-independent.
 *
 * Both halves are load-bearing:
 *  - `pluginVersionId` forks the session when the environment is upgraded to a
 *    different immutable version, even if that version happens to expose the
 *    same server ids and the same skill text;
 *  - `bundleHash` forks it when the CONTENT behind an id differs from what a
 *    resumed sandbox already has materialized.
 *
 * `null` bundle hashes (deploy skew — an older backend omits the field) hash as
 * a distinct sentinel rather than being dropped: unknown content must not read
 * as "same content".
 *
 * Empty list ⇒ `""`, so a turn with no plugins contributes nothing to the
 * harness fingerprint and existing sessions do not cold-start.
 */
export function pluginVersionsFingerprint(
  versions: RuntimePluginVersion[]
): string {
  if (versions.length === 0) return "";
  const canon = versions
    .map((v) => `${v.pluginVersionId}:${v.bundleHash ?? "\u0000unknown"}`)
    .sort()
    .join("\n");
  // FNV-1a, matching `harnessRuntimeFingerprint` / `skillsFingerprint`.
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Which selected servers can actually be delivered into the sandbox's
 * `.mcp.json`, failing CLOSED on a plugin-contributed one that cannot.
 *
 * A selected server with no live config in the manager is skipped (that is the
 * long-standing behavior for host-selected servers, which the user can see and
 * reconnect). A PLUGIN-contributed server is different: hosts are plugin-blind,
 * the environment pinned that version precisely to get those tools, and the
 * silently reduced tool set would surface only as the agent "not doing the
 * thing". Name the plugin and refuse the turn instead — the same all-or-nothing
 * rule the hosted proxy-token mint already applies.
 */
export function selectDeliverableServerIds(args: {
  selectedServerIds: string[];
  /** True when the manager holds a live config for this id. */
  hasLiveConfig: (serverId: string) => boolean;
  /** Plugin origin per server id (`pluginOriginByServerId`); may be empty. */
  pluginOrigins?: Record<string, RuntimePluginVersion>;
  onSkipped?: (serverId: string) => void;
}): string[] {
  const deliverable: string[] = [];
  for (const serverId of args.selectedServerIds) {
    if (args.hasLiveConfig(serverId)) {
      deliverable.push(serverId);
      continue;
    }
    const plugin = args.pluginOrigins?.[serverId];
    if (plugin) {
      throw new Error(
        `Plugin "${plugin.name}" contributes MCP server ${serverId}, but it has no live connection for this turn — refusing to run the harness with missing plugin tools.`
      );
    }
    args.onSkipped?.(serverId);
  }
  return deliverable;
}

/** Where a delivered plugin skill LANDED on the box, and which immutable plugin
 *  revision it came from. */
export interface DeliveredPluginSkillOrigin {
  skillId: string;
  /** Environment-scoped ref (`<plugin>/<skill>`) — the id the emulated engine's
   *  skill tools address, kept here so both engines attribute identically. */
  ref: string;
  /** Absolute on-box dir the runtime reads the skill from. This is the only
   *  identity the model ever sees, so it is the key an observer needs to map a
   *  skill back to its plugin revision. */
  dir: string;
  pluginId: string;
  pluginVersionId: string;
  /** Content address of the bundle the skill came from; `null` on deploy skew
   *  (older backend) — unknown, never "same as before". */
  bundleHash: string | null;
}

/**
 * Attribute the skills a turn ACTUALLY delivered back to their plugin revision
 * (INS-8 origin mapping).
 *
 * Keyed on the on-box dir rather than the skill name alone because that is what
 * the runtime exposes: a Codex turn reads `~/.agents/skills/<name>`, a Claude
 * Code turn `~/.claude/skills/<name>`, and the same skill can be delivered to
 * either. Only skills present in `deliveredNameBySkillId` are reported — an
 * adapter that dropped a skill (name it cannot write) must not be described as
 * having run it — and only PLUGIN skills, since a standalone skill has no plugin
 * revision to attribute to.
 *
 * This is provenance: it records what ran, and is never read back to restore or
 * pin a plugin version.
 */
export function deliveredPluginSkillOrigins(args: {
  set: EffectiveCapabilitySet;
  /** The runtime's skills root (`HarnessRuntimeAdapter.skillsBaseDir`). */
  skillsBaseDir: string;
  /** skillId → on-box dir name, for the skills the adapter was given. */
  deliveredNameBySkillId: Map<string, string>;
}): DeliveredPluginSkillOrigin[] {
  const origins: DeliveredPluginSkillOrigin[] = [];
  for (const skill of args.set.pluginSkills) {
    const name = args.deliveredNameBySkillId.get(skill.skillId);
    if (!name) continue;
    const plugin = skill.plugin;
    if (!plugin) continue;
    origins.push({
      skillId: skill.skillId,
      ref: skill.ref,
      dir: `${args.skillsBaseDir}/${name}`,
      pluginId: plugin.pluginId,
      pluginVersionId: plugin.pluginVersionId,
      bundleHash: plugin.bundleHash,
    });
  }
  return origins;
}

/** One line per delivered plugin skill, for the turn's provenance log. */
export function pluginSkillDeliverySummary(
  set: EffectiveCapabilitySet
): Array<{
  ref: string;
  name: string;
  fileCount: number;
  pluginVersionId: string | null;
}> {
  return set.pluginSkills.map((skill) => ({
    ref: skill.ref,
    name: skill.name,
    fileCount: skill.files.length,
    pluginVersionId: skill.plugin?.pluginVersionId ?? null,
  }));
}
