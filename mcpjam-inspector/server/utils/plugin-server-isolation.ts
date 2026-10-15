import { describeError, type MCPClientManager } from "@mcpjam/sdk";
import type { UIMessageChunk } from "ai";
import {
  PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
  type PluginServerUnavailable,
  type PluginServerUnavailableReason,
} from "@/shared/plugin-server-unavailable";
import { WebRouteError } from "../routes/web/errors.js";
import { logger } from "./logger.js";

/**
 * Interactive chat runs a plugin's admitted servers ISOLATED: one that is
 * refused, fails to start, connect or authenticate, or does not list its
 * tools within the turn's budget contributes no tools, and the turn runs on
 * without it. Only the servers the backend labelled as a plugin's are
 * isolated (`EffectiveCapabilitySet.pluginServerIds`). A plugin's server can
 * never be selected as a standalone one, so every server the member chose
 * still fails the turn with the error it always did.
 */

type ToolsByServer = Awaited<
  ReturnType<MCPClientManager["getToolsForAiSdkByServer"]>
>;

/**
 * List tools by server: the shared servers together exactly as before, each
 * isolated one on its own, recording its failure instead of throwing it.
 */
export async function listToolsByServerIsolating(args: {
  list: (keys: string[]) => Promise<ToolsByServer>;
  keys: readonly string[];
  isolatedKeys: ReadonlySet<string>;
}): Promise<{ byServer: ToolsByServer; failed: Map<string, unknown> }> {
  const shared = args.keys.filter((key) => !args.isolatedKeys.has(key));
  const failed = new Map<string, unknown>();
  const [base, ...own] = await Promise.all([
    shared.length > 0 ? args.list(shared) : Promise.resolve({}),
    ...args.keys
      .filter((key) => args.isolatedKeys.has(key))
      .map((key) =>
        args.list([key]).catch((error: unknown) => {
          failed.set(key, error);
          return {};
        }),
      ),
  ]);
  // Back in the turn's order, so a tool name two servers share resolves to
  // the same server it did when they were listed together.
  const merged: ToolsByServer = Object.assign({}, base, ...own);
  const byServer: ToolsByServer = {};
  for (const key of args.keys) {
    if (Object.hasOwn(merged, key)) byServer[key] = merged[key];
  }
  return { byServer: Object.assign(byServer, merged), failed };
}

type ToolOptions = Parameters<MCPClientManager["getToolsForAiSdkByServer"]>[1];

/**
 * How `prepareChatV2` lists one turn's MCP tools. With no isolated servers it
 * is exactly the manager's own listing, under the turn's budget. With them,
 * each isolated server is listed on its own, under its own budget, alongside
 * the rest. A plugin server that hangs still holds the turn until that budget
 * runs out, as it always did, but is then reported like one that refused, and
 * the turn runs without it instead of failing.
 */
export function createTurnToolLister(args: {
  manager: Pick<
    MCPClientManager,
    "getToolsForAiSdkByServer" | "getToolsForAiSdk" | "listServers"
  >;
  /** The turn's connection keys; `undefined` means every server. */
  serverIds: string[] | undefined;
  isolatedServers: readonly string[];
  /** A server id's connection keys (one per account on a shared server). */
  keysOf: (serverId: string) => string[];
  toolOptions: ToolOptions;
  within: <T>(listing: Promise<T>) => Promise<T>;
}) {
  const { manager, serverIds, toolOptions, within } = args;
  const isolatedKeys = new Set(args.isolatedServers.flatMap(args.keysOf));
  const failed = new Map<string, unknown>();
  const byServer = async (): Promise<ToolsByServer> => {
    if (isolatedKeys.size === 0) {
      return within(manager.getToolsForAiSdkByServer(serverIds, toolOptions));
    }
    const listed = await listToolsByServerIsolating({
      list: (keys) =>
        within(manager.getToolsForAiSdkByServer(keys, toolOptions)),
      keys: serverIds ?? manager.listServers(),
      isolatedKeys,
    });
    listed.failed.forEach((error, key) => failed.set(key, error));
    return listed.byServer;
  };
  return {
    byServer,
    /** Every server's tools in one set, as `getToolsForAiSdk` returns them. */
    flat: async (): ReturnType<MCPClientManager["getToolsForAiSdk"]> =>
      isolatedKeys.size === 0
        ? within(manager.getToolsForAiSdk(serverIds, toolOptions))
        : Object.assign({}, ...Object.values(await byServer())),
    /** Each isolated server the turn runs without, by id, with its error. */
    unavailable: (): Map<string, unknown> => {
      const byId = new Map<string, unknown>();
      for (const serverId of args.isolatedServers) {
        const key = args.keysOf(serverId).find((k) => failed.has(k));
        if (key !== undefined) byId.set(serverId, failed.get(key));
      }
      return byId;
    },
  };
}

/** Describer verdicts that signing in to the server again can fix. */
const SIGN_IN_SLUGS: ReadonlySet<string> = new Set([
  "auth/http_401",
  "auth/missing_bearer",
  "auth/oauth_refresh_failed",
  "auth/consent_required",
  "auth/insufficient_scope",
  "oauth/invalid_grant",
]);

/**
 * What the member is told about a server the turn ran without. A 401 from
 * our own builder (a refused or expired grant, or a tokenless `discover`
 * server the MCP server answered with 401) means sign in; so does a describer
 * verdict that names a missing or refused credential. Anything else, a dead
 * server, a timeout, a refusal for another reason, is `unreachable`.
 */
export function pluginServerUnavailableReason(
  error: unknown,
): PluginServerUnavailableReason {
  for (let cause = error, depth = 0; cause && depth < 5; depth += 1) {
    if (cause instanceof WebRouteError) {
      return cause.status === 401 ? "needs_auth" : "unreachable";
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return SIGN_IN_SLUGS.has(describeError(error).slug)
    ? "needs_auth"
    : "unreachable";
}

/** A chat turn's isolated plugin servers, as the route hands them over. */
export interface IsolatedServers {
  serverIds: readonly string[];
  /** The ones `createAuthorizedManager` refused before connecting, by id. */
  refused?: Readonly<Record<string, unknown>>;
}

/**
 * The isolated servers a turn runs without, in the turn's order: refused
 * before connecting, or failed while listing (`failed`, from `prepareChatV2`).
 */
export function unavailablePluginServers(
  isolated: Partial<IsolatedServers> & {
    failed?: ReadonlyMap<string, unknown>;
  },
): Array<PluginServerUnavailable & { error: unknown }> {
  const refused = isolated.refused ?? {};
  return (isolated.serverIds ?? []).flatMap((serverId) => {
    const error = Object.hasOwn(refused, serverId)
      ? refused[serverId]
      : isolated.failed?.get(serverId);
    if (error === undefined) return [];
    return [{ serverId, reason: pluginServerUnavailableReason(error), error }];
  });
}

/**
 * Tell the browser which plugin servers this turn ran without, and leave the
 * same ids, reasons and describer slugs (never an error's text) in the server
 * log. Best-effort: a failed write costs the notice, never the turn.
 */
export function emitPluginServersUnavailable(
  writer: { write: (chunk: UIMessageChunk) => void } | null | undefined,
  chatSessionId: string | undefined,
  isolated: Parameters<typeof unavailablePluginServers>[0],
): void {
  const servers = unavailablePluginServers(isolated);
  if (servers.length === 0) return;
  logger.warn("[chat] turn ran without plugin servers", {
    chatSessionId,
    servers: servers.map(({ serverId, reason, error }) => ({
      serverId,
      reason,
      slug: describeError(error).slug,
    })),
  });
  if (!writer) return;
  try {
    writer.write({
      type: PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE,
      data: {
        servers: servers.map(({ serverId, reason }) => ({ serverId, reason })),
        ...(chatSessionId ? { chatSessionId } : {}),
      },
      transient: true,
    });
  } catch (error) {
    logger.warn("[chat] plugin server notice stream write failed", { error });
  }
}
