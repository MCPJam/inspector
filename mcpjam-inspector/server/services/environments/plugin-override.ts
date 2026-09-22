/**
 * The Playground's EPHEMERAL plugin narrowing (INS-4).
 *
 * The environment is the source of truth: its `pluginVersionIds` is the
 * baseline, resolved server-side on every turn by
 * `projectEnvironments:resolveEnvironmentForRuntime` (which itself re-runs
 * `resolvePluginVersionsRuntime`, so disable/uninstall/cross-project bite
 * immediately). A Playground turn may ask to run with FEWER of those versions;
 * nothing is written down, and a reload returns to the environment's set.
 *
 * ## Why the narrowing happens here and not in the backend query
 *
 * `resolveEnvironmentForRuntime` accepts `serverOverrideIds` and nothing else —
 * there is no plugin-override argument on the deployed contract, and a Convex
 * validator rejects unknown args, so sending one would break every turn. This
 * module therefore narrows the ALREADY-RESOLVED spec, which keeps the property
 * that matters: the override can only ever REMOVE something the environment
 * already authorized for this caller. It cannot resurrect a disabled,
 * uninstalled or cross-project version, and it cannot reach a version the
 * environment does not pin — those are rejected outright rather than resolved.
 *
 * ## Why it fails closed without attribution
 *
 * Which servers and skills a given version contributed is an EDGE only
 * `./plugin-attribution` can supply. Without it we cannot tell which of the
 * spec's plugin servers belong to the version the user just switched off. The
 * honest outcomes are "run everything" (silently ignoring the user) or "stop".
 * We stop: a turn that keeps talking to a server the user visibly disabled is
 * the worse failure, and the UI can say why.
 */
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import type { PluginRuntimeAttribution } from "./plugin-attribution.js";
import type { ResolvedEnvironmentRuntime } from "./runtime.js";

export interface PluginVersionOverrideResult {
  /** The spec the turn should execute — the input when nothing was dropped. */
  spec: ResolvedEnvironmentRuntime;
  /** Version ids the user switched off for this turn, in pin order. */
  droppedVersionIds: string[];
  /** Server ids removed because their contributing version was dropped. */
  droppedServerIds: string[];
  /** Skill ids removed for the same reason. */
  droppedSkillIds: string[];
}

/**
 * Apply a retained-subset plugin override to a resolved environment spec.
 *
 * `retainedVersionIds` is the subset of the environment's pins to KEEP.
 * Throws a `WebRouteError` when the request cannot be honored exactly:
 *   - 400 when it names a version the environment does not pin (widening);
 *   - 409 when a dropped version's components cannot be attributed.
 */
export function applyPluginVersionOverride(args: {
  spec: ResolvedEnvironmentRuntime;
  attribution: PluginRuntimeAttribution | null;
  retainedVersionIds: string[];
}): PluginVersionOverrideResult {
  const { spec, attribution, retainedVersionIds } = args;
  const pinned = spec.pluginVersions ?? [];
  const pinnedIds = new Set(pinned.map((entry) => entry.pluginVersionId));

  const unknown = retainedVersionIds.filter((id) => !pinnedIds.has(id));
  if (unknown.length > 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A Playground plugin selection can only narrow the environment's pinned plugin versions, not add to them. " +
        "Pin the version on the environment (/environments) to run it here.",
      { code: "ENV_PLUGIN_OVERRIDE_NOT_PINNED", pluginVersionIds: unknown }
    );
  }

  const retained = new Set(retainedVersionIds);
  const droppedVersionIds = pinned
    .map((entry) => entry.pluginVersionId)
    .filter((id) => !retained.has(id));
  if (droppedVersionIds.length === 0) {
    return {
      spec,
      droppedVersionIds: [],
      droppedServerIds: [],
      droppedSkillIds: [],
    };
  }

  const unattributable =
    attribution === null
      ? droppedVersionIds
      : droppedVersionIds.filter((id) =>
          attribution.unattributedVersionIds.includes(id)
        );
  if (unattributable.length > 0) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "This turn was stopped because the servers and skills contributed by the plugin you switched off could not be identified, " +
        "and running anyway would have kept them in the turn. Try again, or reset the plugin selection to the environment.",
      {
        code: "ENV_PLUGIN_OVERRIDE_UNATTRIBUTED",
        pluginVersionIds: unattributable,
      }
    );
  }

  const dropped = new Set(droppedVersionIds);
  const droppedServerIds: string[] = [];
  const droppedSkillIds = new Set<string>();

  // Classification mirrors `resolveEffectiveCapabilities`: the backend's
  // `source` is the verdict. A server the backend called `host_or_group` or
  // `override` stays even if a torn attribution map also names a plugin for it
  // — the host selected it, and a plugin toggle must not remove a host's own
  // server.
  const connectable = spec.servers.connectable;
  const pluginIdHint = new Set(
    (spec.servers.pluginServerIds ?? []).map(String)
  );
  const isPluginContributed = (
    serverId: string,
    source: string | undefined
  ): boolean =>
    source === "plugin" ||
    (source === undefined &&
      (attribution?.serverOrigins.has(serverId) === true ||
        pluginIdHint.has(serverId)));

  const serverIdsToDrop = new Set<string>();
  const candidateServers = Array.isArray(connectable)
    ? connectable.map((entry) => ({
        serverId: entry.serverId,
        source: entry.source as string | undefined,
      }))
    : spec.servers.effectiveServerIds.map((serverId) => ({
        serverId,
        source: undefined,
      }));
  for (const entry of candidateServers) {
    const origin = attribution?.serverOrigins.get(entry.serverId);
    if (!origin || !dropped.has(origin.pluginVersionId)) continue;
    if (!isPluginContributed(entry.serverId, entry.source)) continue;
    serverIdsToDrop.add(entry.serverId);
    droppedServerIds.push(entry.serverId);
  }

  for (const skill of spec.skills ?? []) {
    const origin = attribution?.skillOrigins.get(skill.skillId);
    if (!origin || !dropped.has(origin.plugin.pluginVersionId)) continue;
    // The same skill row can arrive on more than one channel (pinned by the
    // environment AND carried by the plugin). Dropping the plugin drops only
    // the plugin's copy — the environment's own pin still delivers it.
    const channels = Array.isArray(skill.channels) ? skill.channels : [];
    if (channels.some((channel) => channel !== "plugin")) continue;
    droppedSkillIds.add(skill.skillId);
  }

  const narrowed: ResolvedEnvironmentRuntime = {
    ...spec,
    servers: {
      ...spec.servers,
      effectiveServerIds: spec.servers.effectiveServerIds.filter(
        (id) => !serverIdsToDrop.has(id)
      ),
      ...(spec.servers.pluginServerIds
        ? {
            pluginServerIds: spec.servers.pluginServerIds.filter(
              (id) => !serverIdsToDrop.has(id)
            ),
          }
        : {}),
      ...(Array.isArray(connectable)
        ? {
            connectable: connectable.filter(
              (entry) => !serverIdsToDrop.has(entry.serverId)
            ),
          }
        : {}),
    },
    ...(spec.skills
      ? { skills: spec.skills.filter((s) => !droppedSkillIds.has(s.skillId)) }
      : {}),
    ...(spec.pluginVersions
      ? {
          pluginVersions: spec.pluginVersions.filter(
            (entry) => !dropped.has(entry.pluginVersionId)
          ),
        }
      : {}),
  };

  return {
    spec: narrowed,
    droppedVersionIds,
    droppedServerIds,
    droppedSkillIds: [...droppedSkillIds],
  };
}
