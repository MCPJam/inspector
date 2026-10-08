import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import type { PluginNoticePlugin } from "@/lib/plugins/plugin-notice-display";

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
 * Only REMOTE components are ever composed. The plugins are read for the
 * hosted venue in every build, so a plugin with a component that would run on
 * this computer (or in a computer) is skipped as `placement`: nothing the
 * member did not pick starts a process on their machine. An environment they
 * choose explicitly is still how such a plugin runs.
 */

/**
 * A plugin whose active version contributes to a turn right now. Every one of
 * its servers must be remote: the hosted-venue read already skips the rest,
 * and this holds the line if a read ever did not.
 */
export function isRunnablePlugin(plugin: ActivePluginRow): boolean {
  return (
    plugin.status === "active" &&
    !!plugin.pluginVersionId &&
    plugin.servers.every((server) => server.placement === "remote")
  );
}

/** The runnable plugins' active versions, in plugin order, deduped. */
export function runnablePluginVersionIds(
  plugins: readonly ActivePluginRow[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!isRunnablePlugin(plugin)) continue;
    const id = plugin.pluginVersionId as string;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The runnable plugins' server ids, in plugin order, deduped. */
export function runnablePluginServerIds(
  plugins: readonly ActivePluginRow[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!isRunnablePlugin(plugin)) continue;
    for (const server of plugin.servers) {
      if (seen.has(server.serverId)) continue;
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
 * meaningful, and plugin order is stable in the active-plugins read.
 */
export function hiddenEnvironmentCompositionKey(input: {
  hostId: string;
  pluginVersionIds: readonly string[];
  secretIds?: readonly string[];
}): string {
  return JSON.stringify([
    input.hostId,
    input.pluginVersionIds,
    input.secretIds ?? [],
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
 * The installed plugins a turn skips for a reason the member can act on.
 * A plugin someone disabled on purpose is not news, so `disabled` never
 * appears.
 */
export function skippedPluginsForNotice(
  plugins: readonly ActivePluginRow[],
): PluginNoticePlugin[] {
  return plugins.flatMap((plugin) =>
    plugin.status === "skipped" && plugin.reason && plugin.reason !== "disabled"
      ? [
          {
            pluginId: plugin.pluginId,
            name: plugin.name,
            displayName: plugin.displayName,
            reason: plugin.reason,
            ...(plugin.reason === "placement"
              ? { placement: skippedPlacement(plugin) }
              : {}),
          },
        ]
      : [],
  );
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
