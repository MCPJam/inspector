import { makeFunctionReference } from "convex/server";
import {
  emulatedServerPluginId,
  parsePluginDeepLink,
  pluginDeepLinkMatchesRuntime,
  type PluginDeepLink,
} from "../../../shared/plugin-deep-link.js";
import { createConvexClient } from "../evals/route-helpers.js";
import type { PluginServerIdentity } from "./bindings.js";
import { PluginInvocationError } from "./invocation.js";
import { timedPluginStep } from "./timing.js";

/** Publisher-facing names of an installed plugin, from the project's catalog.
 * The installation ID is always accepted; these are optional aliases. */
export interface PluginDeepLinkNames {
  /** Normalized manifest `name` (for example `bits-and-bolts`). */
  name?: string;
  /** A configured published ChatGPT plugin ID, when the project records one. */
  publishedId?: string;
  /** The custom `marketplace.json` name the plugin was installed from. */
  marketplace?: string;
  /** Display label used only to describe refusals. */
  displayName?: string;
}

/** A refused deep link names why and, when ambiguous, every candidate. */
export class PluginDeepLinkRefusal extends PluginInvocationError {
  constructor(
    code:
      | "PLUGIN_DEEP_LINK_NAMESPACE_UNAVAILABLE"
      | "PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED"
      | "PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN"
      | "PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH"
      | "PLUGIN_DEEP_LINK_AMBIGUOUS"
      | "PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE",
    readonly candidates: readonly string[] = [],
  ) {
    super(code);
    this.name = "PluginDeepLinkRefusal";
  }
}

/** Every plugin ID a link may use for this server's plugin. */
export function pluginDeepLinkAliases(
  serverIdentity: PluginServerIdentity,
  names?: PluginDeepLinkNames,
) {
  if (serverIdentity.kind !== "plugin")
    return {
      key: `server:${serverIdentity.serverId}`,
      aliases: [emulatedServerPluginId(serverIdentity.serverId)],
      marketplace: undefined,
    };
  return {
    key: `plugin:${serverIdentity.pluginId}`,
    aliases: [
      serverIdentity.pluginId,
      ...(names?.name ? [names.name] : []),
      ...(names?.publishedId ? [names.publishedId] : []),
    ],
    marketplace: names?.marketplace,
  };
}

/** Source namespace is navigation context; every destination still needs
 * admission. Thread, global, file-viewer and quick-action Apps each get their
 * own namespace; it is never inherited from the App that opened them. Plain
 * servers get an emulated plugin ID derived from their saved server ID. */
export function admittedPluginNavigationNamespace(
  serverIdentity: PluginServerIdentity,
  runtime: "chatgpt" | "codex",
  kind: "thread" | "global" | "quick-action" | "file",
) {
  if (!["thread", "global", "quick-action", "file"].includes(kind))
    return undefined;
  return {
    pluginId:
      serverIdentity.kind === "plugin"
        ? serverIdentity.pluginId
        : emulatedServerPluginId(serverIdentity.serverId),
    runtime,
  };
}

/** Admit a link that opens `target`'s global App. Accepts the installation ID,
 * the manifest name, a published ID, a plain server's emulated ID, and
 * `@marketplace` when it matches the installed plugin's marketplace. */
export function admittedPluginDeepLink(
  url: string | undefined,
  target: {
    serverIdentity: PluginServerIdentity;
    runtime: "chatgpt" | "codex";
    toolName: string;
    kind: "thread" | "global" | "quick-action" | "file";
    names?: PluginDeepLinkNames;
  },
): PluginDeepLink | undefined {
  if (url === undefined) return undefined;
  const link = parsePluginDeepLink(url);
  if (target.kind !== "global")
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_NAMESPACE_UNAVAILABLE");
  if (!pluginDeepLinkMatchesRuntime(link, target.runtime))
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED");
  const own = pluginDeepLinkAliases(target.serverIdentity, target.names);
  if (!own.aliases.includes(link.pluginId))
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN");
  if (link.marketplace !== undefined && link.marketplace !== own.marketplace)
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH");
  if (link.toolName !== target.toolName)
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE");
  return link;
}

export interface PluginDeepLinkCandidate {
  serverId: string;
  serverName?: string;
  serverIdentity: PluginServerIdentity;
  names?: PluginDeepLinkNames;
}

const describeCandidate = (candidate: PluginDeepLinkCandidate) => {
  const label =
    candidate.names?.displayName ??
    candidate.names?.name ??
    candidate.serverName ??
    candidate.serverId;
  return candidate.names?.marketplace
    ? `${label} (@${candidate.names.marketplace})`
    : label;
};

/** Resolve a link clicked or pasted in chat to the installed plugin it names.
 * Exactly one plugin (or plain server) must match; an ambiguous alias is
 * refused naming every candidate, and `@marketplace` disambiguates. Returns
 * that plugin's servers (a plugin may have several). */
export function resolvePluginDeepLinkTarget(
  url: string,
  context: {
    runtime: "chatgpt" | "codex";
    candidates: readonly PluginDeepLinkCandidate[];
  },
) {
  const link = parsePluginDeepLink(url);
  if (!pluginDeepLinkMatchesRuntime(link, context.runtime))
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED");
  const named = context.candidates.filter((candidate) =>
    pluginDeepLinkAliases(candidate.serverIdentity, candidate.names).aliases.includes(
      link.pluginId,
    ),
  );
  if (!named.length)
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN");
  const matching =
    link.marketplace === undefined
      ? named
      : named.filter(
          (candidate) =>
            pluginDeepLinkAliases(candidate.serverIdentity, candidate.names)
              .marketplace === link.marketplace,
        );
  if (!matching.length)
    throw new PluginDeepLinkRefusal(
      "PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH",
      named.map(describeCandidate),
    );
  const plugins = new Map<string, PluginDeepLinkCandidate[]>();
  for (const candidate of matching) {
    const key = pluginDeepLinkAliases(candidate.serverIdentity).key;
    plugins.set(key, [...(plugins.get(key) ?? []), candidate]);
  }
  if (plugins.size > 1)
    throw new PluginDeepLinkRefusal(
      "PLUGIN_DEEP_LINK_AMBIGUOUS",
      [...plugins.values()].map((servers) => describeCandidate(servers[0])),
    );
  return { link, servers: [...plugins.values()][0] };
}

/** When one plugin has several servers, exactly one may declare the global
 * entrypoint the link names. */
export function selectPluginDeepLinkServer(
  servers: readonly PluginDeepLinkCandidate[],
  declares: (candidate: PluginDeepLinkCandidate) => boolean,
) {
  const owners = servers.filter(declares);
  if (!owners.length)
    throw new PluginDeepLinkRefusal("PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE");
  if (owners.length > 1)
    throw new PluginDeepLinkRefusal(
      "PLUGIN_DEEP_LINK_AMBIGUOUS",
      owners.map(
        (owner) => `${describeCandidate(owner)} — ${owner.serverName ?? owner.serverId}`,
      ),
    );
  return owners[0];
}

const PROJECT_PLUGINS_QUERY = makeFunctionReference<"query">(
  "plugins:listProjectPlugins",
);
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;

/** Read the project's installed plugin names (display only; never authority).
 * Optional `marketplace`/`publishedId` fields are honored when the catalog
 * provides them. */
export async function readPluginDeepLinkNames(input: {
  bearer: string;
  projectId: string;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<string, PluginDeepLinkNames>> {
  const rows: unknown = await timedPluginStep("backend-plugin-names", () =>
    createConvexClient(input.bearer).query(PROJECT_PLUGINS_QUERY, {
      projectId: input.projectId,
    }),
  );
  input.signal?.throwIfAborted();
  const names = new Map<string, PluginDeepLinkNames>();
  if (!Array.isArray(rows)) return names;
  for (const row of rows.slice(0, 1024)) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const pluginId = text(value.pluginId);
    if (!pluginId || value.deletedAt !== undefined) continue;
    const marketplace =
      text(value.marketplace) ??
      text((value.source as Record<string, unknown> | undefined)?.marketplace);
    names.set(pluginId, {
      ...(text(value.name) ? { name: text(value.name) } : {}),
      ...(text(value.publishedPluginId)
        ? { publishedId: text(value.publishedPluginId) }
        : {}),
      ...(marketplace ? { marketplace } : {}),
      ...(text(value.displayName)
        ? { displayName: text(value.displayName) }
        : {}),
    });
  }
  return names;
}
