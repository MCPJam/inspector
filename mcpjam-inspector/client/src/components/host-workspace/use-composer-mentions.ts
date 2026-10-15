import { useCallback, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/session-token";
import {
  pluginMentionLink,
  type PluginMentionSelection,
} from "@/shared/plugin-mentions";
import { waitForPluginOperation } from "@/shared/plugin-operation";
import type { ThreadAppScope } from "./thread-app-api";
import { probePluginMention, searchPluginMentions } from "./mention-search";
import { createThreadAppApi } from "./thread-app-api";
import type {
  MentionComposer,
  MentionPlugin,
} from "../chat-v2/chat-input/prompts/mentions-popover";
import type { ContextAttachment } from "../chat-v2/chat-input/attachments/context-attachment-chip";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

const NO_PLUGIN_ICONS: ReadonlyMap<string, PluginIcons> = new Map();

/** A probe that never answers must not hold the plugin list forever. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Composer at-mentions, two steps: "@" lists the connected plugins/servers
 * that declare a mention search tool, then searches only the one picked.
 *
 * Approval: typing must never ask for approval per keystroke. A client that
 * requires tool approval asks once per plugin per composer session (the
 * first search after picking it); later searches against that plugin's
 * declared mention tool reuse that answer. A different chat or server set is
 * a new session.
 */
export function useComposerMentions(
  scope: ThreadAppScope | null,
  servers: readonly { serverId: string; name: string }[],
  approve: Parameters<typeof searchPluginMentions>[0]["approve"],
  /**
   * The project's plugin icons by plugin id. Discovery names the plugin that
   * owns each server; its rows and pill show that plugin's composer icon.
   */
  pluginIcons: ReadonlyMap<string, PluginIcons> = NO_PLUGIN_ICONS,
) {
  const key = JSON.stringify([scope, servers.map((s) => s.serverId)]);
  const current = useRef(key);
  current.current = key;
  // The approval prompt may be a fresh closure every render; the session's
  // probe cache and approvals must not reset with it.
  const approveRef = useRef(approve);
  approveRef.current = approve;
  // Read when "@" lists plugins, so icons that load later still show.
  const pluginIconsRef = useRef(pluginIcons);
  pluginIconsRef.current = pluginIcons;
  const [draft, setDraft] = useState<{
    key: string;
    selections: PluginMentionSelection[];
  }>({ key, selections: [] });
  const selections = draft.key === key ? draft.selections : [];
  const remove = useCallback(
    (index: number) =>
      setDraft((old) =>
        old.key === key
          ? { key, selections: old.selections.filter((_, i) => i !== index) }
          : old,
      ),
    [key],
  );
  const clear = useCallback(() => setDraft({ key, selections: [] }), [key]);
  const mentions: MentionComposer | undefined = useMemo(() => {
    if (!scope) return undefined;
    const workspaceId = scope.pluginWorkspace.workspaceId;
    const post = (action: string, body: unknown, requestSignal?: AbortSignal) =>
      authFetch(`/api/web/apps/plugin-instances/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    const provider = (server: { serverId: string; name: string }) => ({
      projectId: scope.projectId,
      hostId: scope.hostId,
      serverId: server.serverId,
      serverName: server.name,
    });
    const requireLive = (signal: AbortSignal) => () => {
      signal.throwIfAborted();
      if (current.current !== key)
        throw new DOMException("Changed composer", "AbortError");
    };
    const probes = new Map<
      string,
      Promise<Omit<MentionPlugin, "icons"> | null>
    >();
    const approved = new Set<string>();
    const api = createThreadAppApi(scope);
    const probe = (server: (typeof servers)[number]) => {
      let pending = probes.get(server.serverId);
      if (!pending) {
        const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
        // App discovery reports mention search; a server whose response
        // predates that field gets the one-time mention probe instead.
        pending = api
          .discoverServer(server.serverId, signal)
          .then(async (discovered) => {
            const found = discovered.mentionsReported
              ? discovered.mentions.available
              : !!(await probePluginMention({
                  provider: provider(server),
                  workspaceId,
                  signal,
                  post,
                  cleanupError: () => {},
                }));
            return found
              ? {
                  serverId: server.serverId,
                  name: server.name,
                  ...(discovered.pluginId
                    ? { pluginId: discovered.pluginId }
                    : {}),
                  ...(discovered.serverIcons?.length
                    ? { serverIcons: discovered.serverIcons }
                    : {}),
                }
              : null;
          });
        // A failed probe is retried the next time "@" is typed.
        pending.catch(() => {
          if (probes.get(server.serverId) === pending)
            probes.delete(server.serverId);
        });
        probes.set(server.serverId, pending);
      }
      return pending;
    };
    return {
      scope: key,
      workspaceId,
      plugins: async (signal) => {
        const settled = await waitForPluginOperation(signal, () =>
          Promise.allSettled(servers.map(probe)),
        );
        requireLive(signal)();
        const plugins: MentionPlugin[] = [];
        settled.forEach((result, index) => {
          const server = servers[index]!;
          if (result.status === "fulfilled") {
            const found = result.value;
            const icons = found?.pluginId
              ? pluginIconsRef.current.get(found.pluginId)
              : undefined;
            if (found) plugins.push(icons ? { ...found, icons } : found);
            return;
          }
          // One failing server never hides the others.
          logPluginExtensionIssue({
            serverId: server.serverId,
            serverName: server.name,
            code: "mention-discovery-failed",
            level: "warning",
            message: `Couldn't check ${server.name} for mention search, so it isn't listed after "@". Type "@" again to retry.`,
            dedupeKey: `mention-probe:${key}:${server.serverId}`,
          });
        });
        return plugins;
      },
      search: async (serverId, query, signal) => {
        const server = servers.find((value) => value.serverId === serverId);
        if (!server) throw new Error("This plugin is no longer connected");
        try {
          return await searchPluginMentions({
            provider: provider(server),
            query,
            signal,
            requireLive: requireLive(signal),
            workspaceId,
            approve: async (challenge, approvalSignal) => {
              if (approved.has(serverId)) return true;
              const allowed = await approveRef.current(
                challenge,
                approvalSignal,
              );
              if (allowed) approved.add(serverId);
              return allowed;
            },
            cleanupError: () => {},
            post,
          });
        } catch (error) {
          if (!signal.aborted && current.current === key)
            logPluginExtensionIssue({
              serverId: server.serverId,
              serverName: server.name,
              code: "mention-search-failed",
              message: `Searching ${server.name} for "${query.slice(0, 80)}" didn't complete.`,
              level: "error",
              detail: {
                reason: error instanceof Error ? error.message : String(error),
              },
            });
          throw error;
        }
      },
      select: (selection) => {
        if (current.current === key)
          setDraft((old) => {
            const items = old.key === key ? old.selections : [];
            return items.length >= 64
              ? old
              : {
                  key,
                  selections: [...items, structuredClone(selection)],
                };
          });
      },
    };
    // `servers` and `scope` are captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const contextAttachments: ContextAttachment[] = selections.map(
    (selection, index) => {
      const link = pluginMentionLink(selection);
      return {
        id: `mention:${index}`,
        title: link.title ?? link.name,
        description: servers.find((s) => s.serverId === selection.serverId)
          ?.name,
        remove: () => remove(index),
      };
    },
  );
  return { mentions, contextAttachments, selections, clear };
}
