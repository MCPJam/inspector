import { toast } from "@/lib/toast";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type {
  PluginNoticeData,
  PluginNoticePlugin,
  PluginNoticeReason,
} from "@/shared/plugin-notice";

/**
 * The `data-plugin-notice` part (see `shared/plugin-notice.ts`): which of the
 * project's plugins a Playground turn did not load, and why.
 *
 * Shown as ONE plain line per chat, not per turn: a plugin waiting on its
 * sign-in is skipped on every message, and repeating that each time would
 * bury the conversation. The same notice again in the same chat is silent; a
 * different set of skips (another plugin, or the same one for a new reason)
 * says so once more. Every shown notice also lands in the right-rail Logs.
 */

const REASON_COPY: Record<PluginNoticeReason, string> = {
  needs_auth: "sign in to its server first",
  needs_setup: "finish its setup first",
  placement: "its server runs on a local runtime",
  not_ready: "its active version isn't ready yet",
  no_active_version: "it has no active version",
  over_cap: "only 10 plugins load per message",
  server_missing: "one of its servers no longer exists",
  skill_unpinnable: "one of its skills can't be loaded",
  connect_failed: "its server couldn't connect",
};

export const PLUGINS_UNAVAILABLE_MESSAGE =
  "Plugins couldn't load for this message.";

function noticeLabel(plugin: PluginNoticePlugin): string {
  return plugin.displayName?.trim() || plugin.name;
}

function describeSkip(plugin: PluginNoticePlugin): string {
  const reason =
    REASON_COPY[plugin.reason] ?? "it couldn't load for this message";
  return `${noticeLabel(plugin)} was skipped: ${reason}.`;
}

/** The plain line a notice reads as. */
export function describePluginNotice(data: PluginNoticeData): string {
  if (data.kind === "unavailable" || data.plugins.length === 0) {
    return PLUGINS_UNAVAILABLE_MESSAGE;
  }
  const [first, second, ...rest] = data.plugins;
  if (!second) return describeSkip(first!);
  if (rest.length === 0)
    return `${describeSkip(first!)} ${describeSkip(second)}`;
  return `${describeSkip(first!)} ${data.plugins.length - 1} more plugins were skipped; see Logs for details.`;
}

/** Chat id + the sorted `pluginId:reason` pairs (or `unavailable`). */
export function pluginNoticeKey(
  chatSessionId: string,
  data: PluginNoticeData,
): string {
  const signature =
    data.kind === "unavailable"
      ? "unavailable"
      : data.plugins
          .map((plugin) => `${plugin.pluginId}:${plugin.reason}`)
          .sort()
          .join(",");
  return `${chatSessionId}|${signature}`;
}

// Page-lifetime, so a remounted Playground does not repeat a notice the chat
// already showed. Bounded: an open tab can run many chats.
const MAX_SHOWN = 500;
const shownNotices = new Set<string>();

/** Test hook: forget every notice already shown. */
export function resetShownPluginNotices(): void {
  shownNotices.clear();
}

/**
 * Show a plugin notice for this chat unless this exact one was shown already.
 * Returns whether it was shown.
 */
export function showPluginNotice(
  chatSessionId: string,
  data: PluginNoticeData,
): boolean {
  const key = pluginNoticeKey(chatSessionId, data);
  if (shownNotices.has(key)) return false;
  if (shownNotices.size >= MAX_SHOWN) {
    const oldest = shownNotices.values().next().value;
    if (oldest !== undefined) shownNotices.delete(oldest);
  }
  shownNotices.add(key);

  const message = describePluginNotice(data);
  toast.info(message);
  try {
    useTrafficLogStore.getState().addMcpServerLog({
      id: `plugins:notice:${key}`,
      serverId: "plugins",
      serverName: "Plugins",
      direction: "RECEIVE",
      method:
        data.kind === "unavailable" ? "plugins/unavailable" : "plugins/skipped",
      timestamp: new Date().toISOString(),
      payload: {
        level: "warning",
        message,
        chatSessionId,
        plugins: data.plugins.map((plugin) => ({
          pluginId: plugin.pluginId,
          name: noticeLabel(plugin),
          reason: plugin.reason,
        })),
      },
    });
  } catch {
    // Logging must never break the chat that hit the problem.
  }
  return true;
}
