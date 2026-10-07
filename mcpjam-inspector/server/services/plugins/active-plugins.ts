/**
 * The project's ACTIVE plugins for one host-target chat turn.
 *
 * A host-target Playground turn runs every installed, enabled plugin at its
 * active version, re-resolved on every turn by the backend's
 * `plugins:resolveActivePlugins` (member read, feature-gated, per-member
 * readiness, capped). Nothing here is persisted: hosts stay plugin-blind in
 * storage, and a plugin's membership in a turn is decided again on the next
 * one, which is what makes disable/uninstall bite immediately.
 *
 * Two halves, deliberately separate:
 *
 *   - {@link readActivePlugins} — the one network read. Never throws; every
 *     outcome is a value, because a plugin problem must never stop a send.
 *     Its own module so the hosted chat suites can replace it.
 *   - The pure planners ({@link planActivePluginTurn},
 *     {@link dropActivePlugins}) — what the turn connects, which skills it
 *     offers, and which plugins it tells the user it skipped.
 *
 * FAIL SOFT, PER PLUGIN. The backend already skipped every plugin it could not
 * run for this member (whole versions, never parts of one). The Inspector adds
 * two reasons of its own: `over_cap` when the turn's server set would pass the
 * execution-context bound, and `connect_failed` when an implicitly added server
 * refused or could not connect. Either way the plugin drops out whole and the
 * rest of the turn runs.
 */
import type { ConvexHttpClient } from "convex/browser";
import type {
  PluginNoticeData,
  PluginNoticePlugin,
  PluginNoticeReason,
} from "../../../shared/plugin-notice.js";
import { createConvexClient } from "../evals/route-helpers.js";
import {
  resolveEffectiveCapabilities,
  type EffectiveCapabilitySet,
} from "../environments/effective-capabilities.js";
import { parsePluginRuntimeAttribution } from "../environments/plugin-attribution.js";
import type {
  ResolvedEnvironmentRuntime,
  ResolvedEnvironmentSkill,
} from "../environments/runtime.js";
import { PLUGIN_EXECUTION_MAX_SERVER_IDS } from "../plugin-host/admission.js";
import { logger } from "../../utils/logger.js";

const ACTIVE_PLUGINS_FUNCTION_REF = "plugins:resolveActivePlugins" as const;

/**
 * How long the read may take before the turn gives up on plugins.
 *
 * `ConvexHttpClient.query` has no deadline of its own. On expiry the turn runs
 * without plugins and says so, exactly like any other failure here; the
 * dangling query is a pure read whose result is dropped.
 */
export const ACTIVE_PLUGINS_TIMEOUT_MS = 5_000;

/** Where a plugin's local-placement servers would run. See the route. */
export type ActivePluginsVenue = "hosted" | "local";

/** Backend skip reasons, plus anything a newer backend adds. */
export type ActivePluginSkipReason =
  "disabled" | PluginNoticeReason | (string & {});

export interface ActivePluginRow {
  pluginId: string;
  pluginVersionId: string | null;
  name: string;
  displayName: string | null;
  status: "active" | "skipped";
  reason?: ActivePluginSkipReason;
  servers: Array<{ serverId: string; name: string }>;
  skills: Array<{ skillId: string }>;
}

/** The parts of `ActivePluginsResult` the Inspector reads. */
export interface ActivePluginsResult {
  pluginVersions: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string | null;
  }>;
  connectable: Array<{ serverId: string; name: string }>;
  skills: ResolvedEnvironmentSkill[];
  /** Same shape as `plugins:resolvePluginRuntimePreview`'s response. */
  attribution: unknown;
  plugins: ActivePluginRow[];
}

export type ActivePluginsRead =
  /** Gate off, guest, or a backend without the function: no plugins, no notice. */
  | { status: "off" }
  /** The read failed or timed out: no plugins, and the user is told. */
  | { status: "unavailable"; error: string }
  | { status: "ok"; result: ActivePluginsResult };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validate the response into the shape the planners read.
 *
 * Tolerant of additive fields and of malformed ELEMENTS (dropped), strict about
 * the lists themselves: a response without them is not an empty one, it is an
 * unknown one, and is reported as unavailable rather than read as "no plugins".
 */
export function parseActivePluginsResponse(raw: unknown): ActivePluginsRead {
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") {
    return { status: "unavailable", error: "malformed response" };
  }
  if (!raw.enabled) return { status: "off" };
  const servers = raw.servers;
  if (
    !Array.isArray(raw.plugins) ||
    !Array.isArray(raw.pluginVersions) ||
    !Array.isArray(raw.skills) ||
    !isRecord(servers) ||
    !Array.isArray(servers.connectable)
  ) {
    return { status: "unavailable", error: "malformed response" };
  }

  const pluginVersions: ActivePluginsResult["pluginVersions"] = [];
  for (const entry of raw.pluginVersions) {
    if (!isRecord(entry)) continue;
    const pluginId = readString(entry.pluginId);
    const pluginVersionId = readString(entry.pluginVersionId);
    const name = readString(entry.name);
    if (!pluginId || !pluginVersionId || !name) continue;
    pluginVersions.push({
      pluginId,
      pluginVersionId,
      name,
      bundleHash: readString(entry.bundleHash),
    });
  }

  const connectable: ActivePluginsResult["connectable"] = [];
  for (const entry of servers.connectable) {
    if (!isRecord(entry)) continue;
    const serverId = readString(entry.serverId);
    if (!serverId) continue;
    connectable.push({ serverId, name: readString(entry.name) ?? serverId });
  }

  const skills: ResolvedEnvironmentSkill[] = [];
  for (const entry of raw.skills) {
    if (!isRecord(entry)) continue;
    const skillId = readString(entry.skillId);
    const name = readString(entry.name);
    if (!skillId || !name || typeof entry.content !== "string") continue;
    skills.push({
      skillId,
      name,
      description:
        typeof entry.description === "string" ? entry.description : "",
      content: entry.content,
      aggregateHash:
        typeof entry.aggregateHash === "string" ? entry.aggregateHash : "",
      ...(isRecord(entry.extraFrontmatter)
        ? { extraFrontmatter: entry.extraFrontmatter }
        : {}),
      channels: ["plugin"],
      ...(isRecord(entry.provenance) ? { provenance: entry.provenance } : {}),
      files: Array.isArray(entry.files)
        ? entry.files.flatMap((file) => {
            if (!isRecord(file)) return [];
            const path = readString(file.path);
            if (!path) return [];
            return [
              {
                path,
                size: typeof file.size === "number" ? file.size : 0,
                url: readString(file.url),
              },
            ];
          })
        : [],
    });
  }

  const plugins: ActivePluginRow[] = [];
  for (const entry of raw.plugins) {
    if (!isRecord(entry)) continue;
    const pluginId = readString(entry.pluginId);
    const name = readString(entry.name);
    if (!pluginId || !name) continue;
    plugins.push({
      pluginId,
      pluginVersionId: readString(entry.pluginVersionId),
      name,
      displayName: readString(entry.displayName),
      status: entry.status === "active" ? "active" : "skipped",
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      servers: Array.isArray(entry.servers)
        ? entry.servers.flatMap((server) => {
            if (!isRecord(server)) return [];
            const serverId = readString(server.serverId);
            if (!serverId) return [];
            return [{ serverId, name: readString(server.name) ?? serverId }];
          })
        : [],
      skills: Array.isArray(entry.skills)
        ? entry.skills.flatMap((skill) => {
            if (!isRecord(skill)) return [];
            const skillId = readString(skill.skillId);
            return skillId ? [{ skillId }] : [];
          })
        : [],
    });
  }

  return {
    status: "ok",
    result: {
      pluginVersions,
      connectable,
      skills,
      attribution: raw.attribution,
      plugins,
    },
  };
}

/**
 * Read the project's active plugins for this turn. Never throws.
 *
 * `bearer` is a thunk so a failure to resolve one (a delegated key exchange)
 * lands inside the same deadline and the same "unavailable" outcome as the
 * read itself.
 */
export async function readActivePlugins(args: {
  bearer: () => Promise<string>;
  projectId: string;
  runtimeVenue: ActivePluginsVenue;
  /** For tests; production builds the client from the bearer. */
  client?: Pick<ConvexHttpClient, "query">;
}): Promise<ActivePluginsRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      (async () => {
        const client = args.client ?? createConvexClient(await args.bearer());
        return client.query(
          ACTIVE_PLUGINS_FUNCTION_REF as never,
          {
            projectId: args.projectId,
            runtimeVenue: args.runtimeVenue,
            content: true,
          } as never,
        );
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("active plugins read timed out")),
          ACTIVE_PLUGINS_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    return parseActivePluginsResponse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Deploy skew: a backend without the function means "no plugins", not a
    // failure the user needs to hear about.
    if (/could not find public function/i.test(message)) {
      return { status: "off" };
    }
    return { status: "unavailable", error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One plugin skipped by this turn, with the reason the notice carries. */
export type ActivePluginSkip = PluginNoticePlugin;

const NOTICE_REASONS: ReadonlySet<string> = new Set<PluginNoticeReason>([
  "not_ready",
  "no_active_version",
  "over_cap",
  "server_missing",
  "placement",
  "needs_auth",
  "needs_setup",
  "skill_unpinnable",
  "connect_failed",
]);

/**
 * What one host turn runs from its active plugins.
 *
 * `serverIds` / `serverNames` are the TURN's set, index-aligned: the body's
 * selection with every plugin server stripped, then the contributing plugins'
 * servers in plugin order.
 */
export interface ActivePluginTurn {
  /** The body's selection minus every known plugin server, aligned names. */
  explicitServerIds: string[];
  explicitServerNames: string[] | undefined;
  /** The contributing plugins, in plugin order. */
  contributing: ActivePluginRow[];
  /** Their servers, in connection order, and the plugin that owns each. */
  pluginServerIds: string[];
  pluginServerNames: string[];
  pluginIdByServerId: ReadonlyMap<string, string>;
  /** The turn's server set: explicit then plugin. */
  serverIds: string[];
  serverNames: string[] | undefined;
  /**
   * False when the plugins add no server and the body named none of them —
   * the caller then keeps the body's selection exactly as sent.
   */
  changesServers: boolean;
  /** True when the body named a plugin server, which was removed. */
  stripped: boolean;
  /** The plugin-only capability set (servers with origin, `<plugin>/<skill>`). */
  capabilities: EffectiveCapabilitySet;
  /** Every skipped plugin a user would see as on (never `disabled`). */
  skipped: ActivePluginSkip[];
  /** Skip reasons the notice cannot name (a newer backend's), for logs. */
  unknownSkipReasons: string[];
  /** Which plugin owns each server and skill of the read. */
  owners: ComponentOwners;
}

/** The notice for a turn, or `undefined` when nothing needs saying. */
export function activePluginNotice(
  turn: Pick<ActivePluginTurn, "skipped"> | undefined,
): PluginNoticeData | undefined {
  if (!turn || turn.skipped.length === 0) return undefined;
  return { kind: "skipped", plugins: turn.skipped };
}

function skipEntry(
  plugin: ActivePluginRow,
  reason: PluginNoticeReason,
): ActivePluginSkip {
  return {
    pluginId: plugin.pluginId,
    name: plugin.name,
    displayName: plugin.displayName,
    reason,
  };
}

export interface ComponentOwners {
  pluginIdByServerId: Map<string, string>;
  pluginIdBySkillId: Map<string, string>;
}

/**
 * Which plugin owns each contributing server and skill.
 *
 * From the plugin rows (the ACTIVE version's components), falling back to the
 * attribution rows. A component neither names is a contract violation: it is
 * logged once here and left out of the turn, rather than run with no plugin to
 * drop it with.
 */
function componentOwners(result: ActivePluginsResult): ComponentOwners {
  const pluginIdByServerId = new Map<string, string>();
  const pluginIdBySkillId = new Map<string, string>();
  for (const plugin of result.plugins) {
    if (plugin.status !== "active") continue;
    for (const server of plugin.servers) {
      if (!pluginIdByServerId.has(server.serverId)) {
        pluginIdByServerId.set(server.serverId, plugin.pluginId);
      }
    }
    for (const skill of plugin.skills) {
      if (!pluginIdBySkillId.has(skill.skillId)) {
        pluginIdBySkillId.set(skill.skillId, plugin.pluginId);
      }
    }
  }
  // Fallback: the attribution rows key components by version.
  const pluginIdByVersionId = new Map(
    result.pluginVersions.map((version) => [
      version.pluginVersionId,
      version.pluginId,
    ]),
  );
  const attribution = isRecord(result.attribution) ? result.attribution : {};
  for (const component of Array.isArray(attribution.serverComponents)
    ? attribution.serverComponents
    : []) {
    if (!isRecord(component)) continue;
    const serverId = readString(component.materializedServerId);
    const pluginId = pluginIdByVersionId.get(
      readString(component.pluginVersionId) ?? "",
    );
    if (serverId && pluginId && !pluginIdByServerId.has(serverId)) {
      pluginIdByServerId.set(serverId, pluginId);
    }
  }
  for (const entry of Array.isArray(attribution.pluginSkills)
    ? attribution.pluginSkills
    : []) {
    if (!isRecord(entry)) continue;
    const skillId = readString(entry.materializedSkillId);
    const pluginId = pluginIdByVersionId.get(
      readString(entry.pluginVersionId) ?? "",
    );
    if (skillId && pluginId && !pluginIdBySkillId.has(skillId)) {
      pluginIdBySkillId.set(skillId, pluginId);
    }
  }
  const unowned = {
    serverIds: result.connectable
      .map((entry) => entry.serverId)
      .filter((serverId) => !pluginIdByServerId.has(serverId)),
    skillIds: result.skills
      .map((skill) => skill.skillId)
      .filter((skillId) => !pluginIdBySkillId.has(skillId)),
  };
  if (unowned.serverIds.length > 0 || unowned.skillIds.length > 0) {
    logger.warn(
      "[active-plugins] contributing components name no plugin; left out",
      unowned,
    );
  }
  return { pluginIdByServerId, pluginIdBySkillId };
}

/**
 * The plugin-only slice for the contributing plugins, in the shape
 * `resolveEffectiveCapabilities` consumes.
 */
function projectContributing(
  result: ActivePluginsResult,
  owners: ComponentOwners,
  contributing: ActivePluginRow[],
): {
  slice: Pick<
    ResolvedEnvironmentRuntime,
    "servers" | "skills" | "serverSkills" | "pluginVersions"
  >;
  serverNames: string[];
  versionIds: string[];
} {
  const keep = new Set(contributing.map((plugin) => plugin.pluginId));
  const connectable: Array<{
    serverId: string;
    name: string;
    source: "plugin";
  }> = [];
  const seen = new Set<string>();
  for (const entry of result.connectable) {
    const pluginId = owners.pluginIdByServerId.get(entry.serverId);
    if (!pluginId || !keep.has(pluginId) || seen.has(entry.serverId)) continue;
    seen.add(entry.serverId);
    connectable.push({
      serverId: entry.serverId,
      name: entry.name,
      source: "plugin",
    });
  }
  const skills = result.skills.filter((skill) => {
    const pluginId = owners.pluginIdBySkillId.get(skill.skillId);
    return pluginId !== undefined && keep.has(pluginId);
  });
  const pluginVersions = result.pluginVersions
    .filter((version) => keep.has(version.pluginId))
    .map((version) => ({
      pluginId: version.pluginId,
      pluginVersionId: version.pluginVersionId,
      name: version.name,
      ...(version.bundleHash ? { bundleHash: version.bundleHash } : {}),
    }));
  const serverIds = connectable.map((entry) => entry.serverId);
  return {
    slice: {
      servers: {
        selectedServerIds: [],
        pluginServerIds: serverIds,
        baseEffectiveServerIds: serverIds,
        effectiveServerIds: serverIds,
        connectable,
      },
      skills,
      serverSkills: [],
      pluginVersions,
    },
    serverNames: connectable.map((entry) => entry.name),
    versionIds: pluginVersions.map((version) => version.pluginVersionId),
  };
}

function alignedNames(
  ids: readonly string[],
  names: readonly string[] | undefined,
): readonly string[] | undefined {
  return Array.isArray(names) && names.length === ids.length
    ? names
    : undefined;
}

function buildTurn(args: {
  result: ActivePluginsResult;
  owners: ComponentOwners;
  contributing: ActivePluginRow[];
  skipped: ActivePluginSkip[];
  unknownSkipReasons: string[];
  explicitServerIds: string[];
  explicitServerNames: string[] | undefined;
  stripped: boolean;
}): ActivePluginTurn {
  const projected = projectContributing(
    args.result,
    args.owners,
    args.contributing,
  );
  const capabilities = resolveEffectiveCapabilities(
    projected.slice,
    parsePluginRuntimeAttribution(
      args.result.attribution,
      projected.versionIds,
    ),
  );
  const pluginServerIds = capabilities.pluginServerIds;
  const pluginServerNames = projected.serverNames;
  const hasServers = pluginServerIds.length > 0;
  // Ids and names stay index-aligned: a short names list makes every
  // consumer fall back to ids for the WHOLE turn.
  const serverNames =
    args.explicitServerNames || hasServers
      ? [
          ...(args.explicitServerNames ?? args.explicitServerIds),
          ...pluginServerNames,
        ]
      : undefined;
  return {
    explicitServerIds: args.explicitServerIds,
    explicitServerNames: args.explicitServerNames,
    contributing: args.contributing,
    pluginServerIds,
    pluginServerNames,
    pluginIdByServerId: args.owners.pluginIdByServerId,
    serverIds: [...args.explicitServerIds, ...pluginServerIds],
    serverNames,
    changesServers: args.stripped || hasServers,
    stripped: args.stripped,
    capabilities,
    skipped: args.skipped,
    unknownSkipReasons: args.unknownSkipReasons,
    owners: args.owners,
  };
}

/**
 * Plan one host turn from a successful read and the body's selection.
 *
 * `undefined` when the project has no plugin rows at all — the turn is then
 * exactly what it would have been without this feature.
 *
 * In order:
 *   1. Strip EVERY plugin server id the read names (active or skipped) from the
 *      body. Plugin servers arrive only from the resolver; a body that names
 *      one (stale, or hand-built) does not get to connect it.
 *   2. The backend's skips become notice entries, except `disabled` (the admin
 *      turned it off; the user does not see it as on).
 *   3. Active plugins are admitted in plugin order while the turn's server set
 *      stays within {@link PLUGIN_EXECUTION_MAX_SERVER_IDS}; one that would pass
 *      it is skipped whole as `over_cap`. A skills-only plugin always fits.
 */
export function planActivePluginTurn(args: {
  result: ActivePluginsResult;
  selectedServerIds: readonly string[];
  selectedServerNames?: readonly string[];
  maxServerIds?: number;
}): ActivePluginTurn | undefined {
  const { result } = args;
  if (result.plugins.length === 0) return undefined;
  const maxServerIds = args.maxServerIds ?? PLUGIN_EXECUTION_MAX_SERVER_IDS;
  const owners = componentOwners(result);

  const allPluginServerIds = new Set<string>([
    ...result.plugins.flatMap((plugin) =>
      plugin.servers.map((server) => server.serverId),
    ),
    ...result.connectable.map((entry) => entry.serverId),
  ]);
  const bodyNames = alignedNames(
    args.selectedServerIds,
    args.selectedServerNames,
  );
  const explicitServerIds: string[] = [];
  const explicitServerNames: string[] = [];
  const seenExplicit = new Set<string>();
  args.selectedServerIds.forEach((serverId, index) => {
    if (allPluginServerIds.has(serverId) || seenExplicit.has(serverId)) return;
    seenExplicit.add(serverId);
    explicitServerIds.push(serverId);
    if (bodyNames) explicitServerNames.push(bodyNames[index]!);
  });
  const stripped = explicitServerIds.length !== args.selectedServerIds.length;

  const skipped: ActivePluginSkip[] = [];
  const unknownSkipReasons: string[] = [];
  for (const plugin of result.plugins) {
    if (plugin.status !== "skipped") continue;
    const reason = plugin.reason;
    if (reason === "disabled") continue;
    if (reason && NOTICE_REASONS.has(reason)) {
      skipped.push(skipEntry(plugin, reason as PluginNoticeReason));
    } else {
      unknownSkipReasons.push(reason ?? "unspecified");
    }
  }

  // The admission bound counts the whole turn, so the cap is decided on the
  // servers each plugin would actually add.
  const serverCountByPlugin = new Map<string, number>();
  for (const serverId of new Set(
    result.connectable.map((entry) => entry.serverId),
  )) {
    const pluginId = owners.pluginIdByServerId.get(serverId);
    if (!pluginId) continue;
    serverCountByPlugin.set(
      pluginId,
      (serverCountByPlugin.get(pluginId) ?? 0) + 1,
    );
  }
  const contributing: ActivePluginRow[] = [];
  let serverCount = explicitServerIds.length;
  for (const plugin of result.plugins) {
    if (plugin.status !== "active") continue;
    const adds = serverCountByPlugin.get(plugin.pluginId) ?? 0;
    if (adds > 0 && serverCount + adds > maxServerIds) {
      skipped.push(skipEntry(plugin, "over_cap"));
      continue;
    }
    serverCount += adds;
    contributing.push(plugin);
  }

  return buildTurn({
    result,
    owners,
    contributing,
    skipped,
    unknownSkipReasons,
    explicitServerIds: stripped
      ? explicitServerIds
      : [...args.selectedServerIds],
    explicitServerNames: stripped
      ? bodyNames
        ? explicitServerNames
        : undefined
      : bodyNames
        ? [...bodyNames]
        : undefined,
    stripped,
  });
}

/**
 * The same turn without some of its plugins — used when an implicitly added
 * server refused or failed to connect. Each dropped plugin leaves whole
 * (servers, skills, version) and joins the notice with `reason`.
 *
 * Never admits anything new: a plugin skipped earlier (over the cap, say)
 * stays skipped even though a drop freed room, because it was never connected.
 */
export function dropActivePlugins(
  turn: ActivePluginTurn,
  result: ActivePluginsResult,
  pluginIds: Iterable<string>,
  reason: PluginNoticeReason,
): ActivePluginTurn {
  const drop = new Set(pluginIds);
  if (drop.size === 0) return turn;
  const dropped = turn.contributing.filter((plugin) =>
    drop.has(plugin.pluginId),
  );
  if (dropped.length === 0) return turn;
  return buildTurn({
    result,
    owners: turn.owners,
    contributing: turn.contributing.filter(
      (plugin) => !drop.has(plugin.pluginId),
    ),
    skipped: [
      ...turn.skipped,
      ...dropped.map((plugin) => skipEntry(plugin, reason)),
    ],
    unknownSkipReasons: turn.unknownSkipReasons,
    explicitServerIds: turn.explicitServerIds,
    explicitServerNames: turn.explicitServerNames,
    stripped: turn.stripped,
  });
}

/**
 * The servers each contributing plugin adds, grouped for the manager's
 * all-or-nothing optional connect: one server of a plugin failing drops them
 * all.
 */
export function activePluginServerGroups(
  turn: ActivePluginTurn,
): Array<{ key: string; serverIds: string[] }> {
  const groups = new Map<string, string[]>();
  for (const serverId of turn.pluginServerIds) {
    const pluginId = turn.pluginIdByServerId.get(serverId);
    if (!pluginId) continue;
    groups.set(pluginId, [...(groups.get(pluginId) ?? []), serverId]);
  }
  return [...groups].map(([key, serverIds]) => ({ key, serverIds }));
}
