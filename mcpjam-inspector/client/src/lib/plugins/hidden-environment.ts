import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import type { PluginNoticePlugin } from "@/lib/plugins/plugin-notice-display";
import type { PluginServerUnavailable } from "@/shared/plugin-server-unavailable";

/**
 * How a Playground chat runs the project's installed plugins while the
 * environments UI is hidden.
 *
 * Plugins reach a turn only through an environment's plugin pins. A chat that
 * would otherwise be a plain client turn therefore runs as a HIDDEN ad-hoc
 * environment — the selected client, no stored servers, and the plugins'
 * active versions — composed once per (client, plugin version set) and deduped
 * by the backend's fingerprint. Every turn then names the chat's own selected
 * servers plus the plugins' servers as its server override, so what runs is
 * what a client turn would have run, plus the plugins.
 *
 * Only a project with at least one runnable plugin takes this path. Every other
 * chat keeps today's client turn, request body included.
 *
 * Where those plugins run is the composition's VENUE (see
 * {@link hiddenEnvironmentVenue}). Hosted composes remote components only, so
 * a plugin with a component that would start a process is skipped as
 * `placement`. Local also composes components that start a process on this
 * machine, and only follows the member's own choice to run this chat's client
 * here. An environment they choose explicitly is the other way such a plugin
 * runs.
 */

/**
 * `hosted`: remote components only. `local`: remote components, plus ones
 * that start a process on this machine.
 */
export type HiddenEnvironmentVenue = "hosted" | "local";

/**
 * The venue a Playground chat's plugins are composed for.
 *
 * `local` only when ALL of these hold:
 * - this is not the hosted app, which can never reach the member's machine;
 * - the member chose to run this chat's client here and authorized it
 *   (`clientRunsHere`);
 * - a plugin needs it (`needsLocal`).
 *
 * A local build alone is not that choice, and neither is a client profile
 * named after a desktop app. Without a plugin that needs it, the chat keeps
 * the route it had.
 */
export function hiddenEnvironmentVenue(args: {
  hostedMode: boolean;
  clientRunsHere: boolean;
  needsLocal: boolean;
}): HiddenEnvironmentVenue {
  return !args.hostedMode && args.clientRunsHere && args.needsLocal
    ? "local"
    : "hosted";
}

/**
 * A plugin whose active version contributes to a turn right now. Every one of
 * its servers must be able to run in `venue`. The read already skips the rest,
 * and this holds the line if a read ever did not.
 */
export function isRunnablePlugin(
  plugin: ActivePluginRow,
  venue: HiddenEnvironmentVenue = "hosted",
): boolean {
  return (
    plugin.status === "active" &&
    !!plugin.pluginVersionId &&
    plugin.servers.every(
      (server) =>
        server.placement === "remote" ||
        (venue === "local" && server.placement === "local"),
    )
  );
}

/**
 * A plugin that runs only once the venue is `local`: runnable there, with a
 * server that starts a process on this machine. One whose local server still
 * waits on setup counts too. Its remote servers and skills run there, and it
 * runs without that server and says so. Composed hosted, the whole plugin
 * would drop, depending on which other plugins are installed.
 */
export function needsLocalVenue(plugin: ActivePluginRow): boolean {
  return (
    isRunnablePlugin(plugin, "local") &&
    plugin.servers.some((server) => server.placement === "local")
  );
}

/** The runnable plugins' active versions, in plugin order, deduped. */
export function runnablePluginVersionIds(
  plugins: readonly ActivePluginRow[],
  venue: HiddenEnvironmentVenue = "hosted",
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!isRunnablePlugin(plugin, venue)) continue;
    const id = plugin.pluginVersionId as string;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The runnable plugins' server ids, in plugin order, deduped. A server this
 * member can't use yet is left out: naming it would connect it and fail.
 */
export function runnablePluginServerIds(
  plugins: readonly ActivePluginRow[],
  venue: HiddenEnvironmentVenue = "hosted",
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!isRunnablePlugin(plugin, venue)) continue;
    for (const server of plugin.servers) {
      if (server.unavailable || seen.has(server.serverId)) continue;
      seen.add(server.serverId);
      ids.push(server.serverId);
    }
  }
  return ids;
}

/**
 * What a hidden environment is composed from. Two equal keys are the same
 * ad-hoc row (the backend fingerprints the same fields), so the composition is
 * re-ensured only when this changes — never per message.
 *
 * Order is kept, not sorted: the backend's fingerprint treats array order as
 * meaningful, and plugin order is stable in the active-plugins read. A local
 * venue is part of the key, so a change of venue always recomposes.
 */
export function hiddenEnvironmentCompositionKey(input: {
  hostId: string;
  pluginVersionIds: readonly string[];
  secretIds?: readonly string[];
  venue?: HiddenEnvironmentVenue;
}): string {
  return JSON.stringify([
    input.hostId,
    input.pluginVersionIds,
    input.secretIds ?? [],
    ...(input.venue === "local" ? ["local"] : []),
  ]);
}

/**
 * The turn's server override: the chat's own selected servers, then the
 * plugins' servers, deduped.
 *
 * The backend REPLACES the environment's set with an override, so the plugin
 * servers have to be named here to stay on. Always an explicit list, never
 * "follow the environment": an empty list is a real answer ("no MCP servers"),
 * exactly as a client turn with nothing selected.
 */
export function hiddenEnvironmentServerOverride(
  selectedServerIds: readonly string[],
  pluginServerIds: readonly string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [...selectedServerIds, ...pluginServerIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The installed plugins a turn skips, whole or in part, for a reason the
 * member can act on. A plugin someone disabled on purpose is not news, so
 * `disabled` never appears.
 */
export function skippedPluginsForNotice(
  plugins: readonly ActivePluginRow[],
): PluginNoticePlugin[] {
  return plugins.flatMap((plugin): PluginNoticePlugin[] => {
    const identity = {
      pluginId: plugin.pluginId,
      name: plugin.name,
      displayName: plugin.displayName,
    };
    if (plugin.status === "active") {
      // The one signing in fixes, when there is one: a turn's report picks
      // the same, and only that one gets a Sign in.
      const server =
        plugin.servers.find(
          (candidate) => candidate.unavailable === "needs_auth",
        ) ?? plugin.servers.find((candidate) => candidate.unavailable);
      const reason = server?.unavailable;
      return server && reason
        ? [
            {
              ...identity,
              reason,
              partial: true,
              ...signInFor(plugin, reason, server.componentKey),
            },
          ]
        : [];
    }
    return plugin.status === "skipped" &&
      plugin.reason &&
      plugin.reason !== "disabled"
      ? [
          {
            ...identity,
            reason: plugin.reason,
            ...(plugin.reason === "placement"
              ? { placement: skippedPlacement(plugin) }
              : {}),
            ...signInFor(plugin, plugin.reason, plugin.componentKey),
          },
        ]
      : [];
  });
}

/** The server a notice offers Sign in for, when signing in is its fix. */
function signInFor(
  plugin: ActivePluginRow,
  reason: string,
  componentKey: string | undefined,
): Pick<PluginNoticePlugin, "signIn"> {
  return reason === "needs_auth" && plugin.pluginVersionId && componentKey
    ? { signIn: { pluginVersionId: plugin.pluginVersionId, componentKey } }
    : {};
}

/**
 * The plugins a turn ran without one of their servers, for the plugin notice.
 * A server is matched to the plugin that lists it; a plugin with a server that
 * needs a sign-in says that, since it is the one the member can act on.
 */
export function unavailableServersForNotice(
  plugins: readonly ActivePluginRow[],
  servers: readonly PluginServerUnavailable[],
): PluginNoticePlugin[] {
  return plugins.flatMap((plugin): PluginNoticePlugin[] => {
    const own = servers.filter((unavailable) =>
      plugin.servers.some((server) => server.serverId === unavailable.serverId),
    );
    const chosen =
      own.find((unavailable) => unavailable.reason === "needs_auth") ?? own[0];
    if (!chosen) return [];
    const componentKey = plugin.servers.find(
      (server) => server.serverId === chosen.serverId,
    )?.componentKey;
    return [
      {
        pluginId: plugin.pluginId,
        name: plugin.name,
        displayName: plugin.displayName,
        reason: chosen.reason,
        partial: true,
        ...signInFor(plugin, chosen.reason, componentKey),
      },
    ];
  });
}

/** Where the component a `placement` skip names would have run. */
function skippedPlacement(plugin: ActivePluginRow): "local" | "computer" {
  const named = plugin.servers.find(
    (server) => server.componentKey === plugin.componentKey,
  );
  const placement =
    named?.placement ??
    plugin.servers.find((server) => server.placement !== "remote")?.placement;
  return placement === "computer" ? "computer" : "local";
}

// ── One retry when a plugin changed under the chat ──────────────────────────

/**
 * Refusals that mean "a plugin this composition pinned changed since it was
 * composed" (disabled, uninstalled, moved to another version, or a component
 * this venue cannot run). A fresh read and a new composition can fix them, so
 * the turn is retried once.
 */
export const HIDDEN_ENVIRONMENT_RECOVERABLE_CODES: ReadonlySet<string> =
  new Set(["ENV_PLUGIN_UNAVAILABLE", "ENV_PLUGIN_COMPONENT_UNSUPPORTED"]);

/** The `ENV_*` code of a recoverable refusal, or null. Never consumes `response`. */
export async function readRecoverableHiddenEnvironmentCode(
  response: Response,
): Promise<string | null> {
  if (response.ok || response.status !== 409) return null;
  try {
    const payload = (await response.clone().json()) as {
      details?: { code?: unknown };
    } | null;
    const code = payload?.details?.code;
    return typeof code === "string" &&
      HIDDEN_ENVIRONMENT_RECOVERABLE_CODES.has(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

/**
 * The same request body, pointed at the recomposed environment — or, when no
 * plugin is runnable any more, at the client itself as a plain client turn.
 *
 * Only the fields the composition owns change: the target, and the plugin
 * half of the server override. The chat's own servers are the body's resolved
 * `selectedServerIds`, which every hosted body carries.
 */
export function retargetHiddenEnvironmentBody(
  body: string,
  next:
    | { environmentId: string; pluginServerIds: readonly string[] }
    | { environmentId: null; hostId: string },
): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const selected = Array.isArray(parsed.selectedServerIds)
    ? (parsed.selectedServerIds as unknown[]).filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const {
    executionTarget: _target,
    environmentOverrides: _overrides,
    includeProjectSkills,
    ...rest
  } = parsed;
  if (next.environmentId === null) {
    // Same shape a client turn has always sent: `hostId`, no target, no
    // override, no environment-only fields.
    return JSON.stringify({ ...rest, hostId: next.hostId });
  }
  return JSON.stringify({
    ...rest,
    executionTarget: { kind: "environment", environmentId: next.environmentId },
    environmentOverrides: {
      serverIds: hiddenEnvironmentServerOverride(
        selected,
        next.pluginServerIds,
      ),
    },
    ...(includeProjectSkills !== undefined ? { includeProjectSkills } : {}),
  });
}

export const HIDDEN_ENVIRONMENT_RETRY_FAILED_MESSAGE =
  "A plugin this chat uses changed and couldn't be loaded. Check the plugin in Servers, then send your message again.";

/**
 * The refusal, restated in plain words. The original names an environment the
 * member never chose (the environments UI is hidden from them), so its prose
 * and details are dropped; the status and headers (request id) are kept.
 */
export function plainHiddenEnvironmentFailure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(
    JSON.stringify({
      code: "CONFLICT",
      message: HIDDEN_ENVIRONMENT_RETRY_FAILED_MESSAGE,
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}
