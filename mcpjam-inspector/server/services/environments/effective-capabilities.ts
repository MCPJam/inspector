/**
 * `EffectiveCapabilitySet` — the ONE object a turn asks "what may this run
 * reach?" (INS-3).
 *
 * It is a PROJECTION, not a resolver. Every lifecycle decision — which pinned
 * versions are usable, which servers they contribute, which skills compose from
 * which channel — was already made backend-side by
 * `lib/pluginRuntimeResolution.resolvePluginVersionsRuntime` and
 * `lib/projectEnvironments.resolveEnvironment`, and re-made on EVERY launch so
 * disable/uninstall bite immediately. Nothing here re-decides any of it; doing
 * so would fork the rules that exist precisely so they cannot fork.
 *
 * What this adds is the shape the runtime needs and the wire does not carry:
 *
 *   - the explicit / plugin / effective server SPLIT, so a consumer can say
 *     which servers a plugin brought without re-deriving it;
 *   - per-server and per-skill PLUGIN ORIGIN (from `./plugin-attribution`), so
 *     a tool call or trace frame names the version it came from;
 *   - NAMESPACED skill refs (`<plugin>/<skill>`), so two plugins declaring the
 *     same skill name stay distinguishable at load time;
 *   - `problems` — provenance we could NOT establish, surfaced instead of
 *     silently rendered as absence.
 *
 * `problems` is deliberately NOT an error channel. Anything that makes a turn
 * unrunnable already threw backend-side as a structured `ENV_*` failure before
 * this module ever sees a spec. These are degradations in what we can SAY,
 * never in what runs.
 *
 * Hosts stay plugin-blind throughout: the pin lives on the environment, this
 * set is assembled per turn from the environment's own resolution, and nothing
 * here is persisted. Recording which versions ran is provenance; it is not a
 * restorable pin.
 */
import type {
  ResolvedEnvironmentRuntime,
  RuntimeServerSource,
  RuntimeSkillChannel,
} from "./runtime.js";
import type {
  AttributedPluginVersion,
  PluginRuntimeAttribution,
} from "./plugin-attribution.js";

/** Identity + reproducibility anchor of one version that contributed to a turn. */
export interface RuntimePluginVersion {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  /** `null` only under deploy skew; never synthesized. */
  bundleHash: string | null;
}

/** A connectable server plus where it came from. */
export interface RuntimeServerOrigin {
  serverId: string;
  name: string;
  /** `null` when an older backend omits the name-carrying projection. */
  source: RuntimeServerSource | null;
  /** Present only for a server a pinned plugin version contributed. */
  plugin?: RuntimePluginVersion;
}

/** A supporting file reachable for this turn. */
export interface RuntimeSkillFile {
  path: string;
  size: number;
  /** Signed, short-lived. `null` when the backend could not mint one. */
  url: string | null;
}

interface RuntimeSkillBase {
  /**
   * The identity the model uses in `loadSkill` / `listSkillFiles` /
   * `readSkillFile`: the bare name for a standalone skill, `<plugin>/<skill>`
   * for a plugin one. Refs are unique within a set.
   */
  ref: string;
  skillId: string;
  /** The materialized skill's own name — NOT unique across plugins. */
  name: string;
  description: string;
  content: string;
  /** Folds supporting files; equals the content hash when there are none. */
  aggregateHash: string;
  files: RuntimeSkillFile[];
}

export interface RuntimePluginSkill extends RuntimeSkillBase {
  /** `undefined` when attribution was unavailable — see `problems`. */
  plugin?: RuntimePluginVersion;
}

export interface RuntimeStandaloneSkill extends RuntimeSkillBase {
  /** Which channel(s) delivered it; `[]` under deploy skew. */
  channels: RuntimeSkillChannel[];
}

/** A captured skill selected from one connected MCP server. */
export interface RuntimeServerSkill extends RuntimeSkillBase {
  serverId: string;
  serverLabel: string;
  skillUri: string;
  versionId: string;
  versionNumber: number;
  capturedAt: number;
}

export type RuntimeCapabilityProblem =
  | {
      /** Pins exist but their component→version edges could not be read. */
      code: "plugin_origin_unavailable";
      message: string;
    }
  | {
      /** A plugin-channel skill with no namespaced ref — it keeps its bare name. */
      code: "plugin_skill_ref_unavailable";
      message: string;
      skillId: string;
    }
  | {
      /** Two skills resolved to one ref; the later one is unreachable by ref. */
      code: "skill_ref_collision";
      message: string;
      ref: string;
      skillId: string;
    };

export interface EffectiveCapabilitySet {
  /** Servers the host/group selected — no plugin contributed them. */
  explicitServerIds: string[];
  /** Servers contributed by pinned plugin versions. */
  pluginServerIds: string[];
  /** The set this turn actually connects, in connection order. */
  effectiveServerIds: string[];
  /** `effectiveServerIds` with display name and origin, index-aligned. */
  servers: RuntimeServerOrigin[];
  pluginSkills: RuntimePluginSkill[];
  standaloneSkills: RuntimeStandaloneSkill[];
  serverSkills: RuntimeServerSkill[];
  /** Every version that contributed to this turn, in pin order. */
  pluginVersions: RuntimePluginVersion[];
  problems: RuntimeCapabilityProblem[];
}

function toRuntimePluginVersion(
  attributed: AttributedPluginVersion
): RuntimePluginVersion {
  return {
    pluginId: attributed.pluginId,
    pluginVersionId: attributed.pluginVersionId,
    name: attributed.name,
    bundleHash: attributed.bundleHash,
  };
}

/**
 * Exactly the parts of a resolved environment this projection reads.
 *
 * Narrower than `ResolvedEnvironmentRuntime` on purpose. A `ResolvedEnvironmentRuntime`
 * still satisfies it structurally, so the interactive caller is unchanged — but
 * a caller with a run SNAPSHOT rather than a live environment (INS-5) can now
 * supply what it genuinely has instead of fabricating an `environmentRef` and a
 * `host.runtimeConfig` this function never looks at. A fabricated host field is
 * a lie that only reads as one at the next person to grep for it.
 */
export type EffectiveCapabilityInput = Pick<
  ResolvedEnvironmentRuntime,
  "servers" | "skills" | "serverSkills" | "pluginVersions"
>;

/**
 * Project one resolved environment spec into the turn's capability set.
 *
 * `attribution` is `null` when `fetchPluginRuntimeAttribution` could not read
 * the component→version edges. That degrades origin reporting and namespacing —
 * it never changes which servers connect or which skills are advertised, both
 * of which come straight from the spec.
 */
export function resolveEffectiveCapabilities(
  spec: EffectiveCapabilityInput,
  attribution: PluginRuntimeAttribution | null
): EffectiveCapabilitySet {
  const problems: RuntimeCapabilityProblem[] = [];
  const pinned = spec.pluginVersions ?? [];

  // Both "no attribution at all" and "attribution missing some pins" are the
  // same fact to a consumer: some of what runs has no stated origin. A short
  // map reported as complete is the silence `problems` exists to prevent.
  const unattributedCount =
    attribution === null
      ? pinned.length
      : attribution.unattributedVersionIds.length;
  if (unattributedCount > 0) {
    problems.push({
      code: "plugin_origin_unavailable",
      message:
        unattributedCount === pinned.length
          ? "This turn's pinned plugin versions could not be attributed to their servers and skills. Tools and skills still run; their plugin origin is not shown."
          : `${unattributedCount} of this turn's ${pinned.length} pinned plugin versions could not be attributed to their servers and skills. Those tools and skills still run; their plugin origin is not shown.`,
    });
  }

  // Pin order, straight from the spec — the authoritative list of what ran.
  // Enriched only where attribution agrees on identity; never replaced by it.
  const pluginVersions: RuntimePluginVersion[] = pinned.map((entry) => ({
    pluginId: entry.pluginId,
    pluginVersionId: entry.pluginVersionId,
    name: entry.name,
    bundleHash: entry.bundleHash ?? null,
  }));

  // ── Servers ────────────────────────────────────────────────────────────────
  // `connectable` is the healed, ordered projection the backend already built;
  // fall back to raw ids under deploy skew, where absence of a name is
  // semantic (the manager shows the id) rather than a reason to guess.
  const connectable = Array.isArray(spec.servers.connectable)
    ? spec.servers.connectable
    : spec.servers.effectiveServerIds.map((serverId) => ({
        serverId,
        name: serverId,
        source: undefined as RuntimeServerSource | undefined,
      }));

  // `servers.pluginServerIds` is the BASE plugin set: it predates any per-turn
  // override, so an override that dropped a plugin server would still list it.
  // Membership is therefore tested against what we are actually connecting.
  const pluginIdHint = new Set(
    (spec.servers.pluginServerIds ?? []).map(String)
  );

  const servers: RuntimeServerOrigin[] = [];
  const explicitServerIds: string[] = [];
  const pluginServerIds: string[] = [];
  for (const entry of connectable) {
    const origin = attribution?.serverOrigins.get(entry.serverId);
    // The backend's `source` is the verdict, in BOTH directions: an entry it
    // labelled `host_or_group` or `override` stays non-plugin even if a stale
    // or torn attribution map still has an entry for that id. Attribution feeds
    // what we SAY about a server, never how we classify it. Our own signals —
    // the attribution map and the base `pluginServerIds` hint — apply only when
    // an older backend omitted `source` entirely.
    const isPlugin =
      entry.source === "plugin" ||
      (entry.source === undefined &&
        (origin !== undefined || pluginIdHint.has(entry.serverId)));
    if (isPlugin) {
      pluginServerIds.push(entry.serverId);
    } else {
      explicitServerIds.push(entry.serverId);
    }
    servers.push({
      serverId: entry.serverId,
      name: entry.name,
      source: entry.source ?? null,
      // Gated on `isPlugin` for the same reason the classification is: a stale
      // attribution entry must not stamp a plugin origin onto the trace frames
      // of a server the backend called `host_or_group` or `override`.
      ...(isPlugin && origin ? { plugin: toRuntimePluginVersion(origin) } : {}),
    });
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  const pluginSkills: RuntimePluginSkill[] = [];
  const standaloneSkills: RuntimeStandaloneSkill[] = [];
  const serverSkills: RuntimeServerSkill[] = [];
  const usedRefs = new Set<string>();

  for (const skill of spec.skills ?? []) {
    const channels = Array.isArray(skill.channels) ? skill.channels : [];
    const attributed = attribution?.skillOrigins.get(skill.skillId);
    // A skill can arrive through several channels at once (the same row pinned
    // by an environment AND carried by a plugin). Plugin origin wins the
    // namespace: it is the more specific identity, and it is the one that has
    // to survive two plugins declaring the same name.
    const isPlugin = attributed !== undefined || channels.includes("plugin");

    const base = {
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      aggregateHash: skill.aggregateHash,
      files: Array.isArray(skill.files) ? skill.files : [],
    };

    if (isPlugin) {
      if (attributed === undefined) {
        problems.push({
          code: "plugin_skill_ref_unavailable",
          message: `Plugin skill "${skill.name}" has no namespaced reference; it is offered under its bare name.`,
          skillId: skill.skillId,
        });
      }
      const ref = attributed?.modelRef ?? skill.name;
      if (usedRefs.has(ref)) {
        problems.push({
          code: "skill_ref_collision",
          message: `Two skills resolved to the reference "${ref}"; only the first is loadable.`,
          ref,
          skillId: skill.skillId,
        });
        continue;
      }
      usedRefs.add(ref);
      pluginSkills.push({
        ...base,
        ref,
        ...(attributed
          ? { plugin: toRuntimePluginVersion(attributed.plugin) }
          : {}),
      });
      continue;
    }

    const ref = skill.name;
    if (usedRefs.has(ref)) {
      problems.push({
        code: "skill_ref_collision",
        message: `Two skills resolved to the reference "${ref}"; only the first is loadable.`,
        ref,
        skillId: skill.skillId,
      });
      continue;
    }
    usedRefs.add(ref);
    standaloneSkills.push({ ...base, ref, channels });
  }

  for (const skill of spec.serverSkills ?? []) {
    if (usedRefs.has(skill.ref)) {
      problems.push({
        code: "skill_ref_collision",
        message: `Two skills resolved to the reference "${skill.ref}"; only the first is loadable.`,
        ref: skill.ref,
        skillId: skill.serverSkillId,
      });
      continue;
    }
    usedRefs.add(skill.ref);
    serverSkills.push({
      skillId: skill.serverSkillId,
      ref: skill.ref,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      aggregateHash: skill.versionHash,
      files: Array.isArray(skill.files) ? skill.files : [],
      serverId: skill.serverId,
      serverLabel: skill.serverLabel,
      skillUri: skill.skillUri,
      versionId: skill.versionId,
      versionNumber: skill.versionNumber,
      capturedAt: skill.capturedAt,
    });
  }

  return {
    explicitServerIds,
    pluginServerIds,
    effectiveServerIds: servers.map((entry) => entry.serverId),
    servers,
    pluginSkills,
    standaloneSkills,
    serverSkills,
    pluginVersions,
    problems,
  };
}

/**
 * Plugin origin keyed by server id — the lookup the RPC-trace collector and any
 * approval surface needs. Only servers a plugin contributed appear.
 */
export function pluginOriginByServerId(
  set: EffectiveCapabilitySet
): Record<string, RuntimePluginVersion> {
  const byId: Record<string, RuntimePluginVersion> = {};
  for (const entry of set.servers) {
    if (entry.plugin) byId[entry.serverId] = entry.plugin;
  }
  return byId;
}

/** Every skill in the set, plugin channel first (stable advertisement order). */
export function allEffectiveSkills(
  set: EffectiveCapabilitySet
): Array<RuntimePluginSkill | RuntimeStandaloneSkill | RuntimeServerSkill> {
  return [...set.pluginSkills, ...set.standaloneSkills, ...set.serverSkills];
}
