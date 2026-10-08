import { HOSTED_MODE } from "@/lib/config";
import { toast } from "@/lib/toast";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type { ActivePluginSkipReason } from "@/lib/plugins/active-plugins-types";

/**
 * What a Playground chat says about the project's installed plugins it did not
 * run, and why. The facts come from the client's own read of the active
 * plugins (`plugins:resolveActivePlugins`), not from the chat stream.
 *
 * Shown as ONE plain line per chat, not per turn: a plugin waiting on its
 * sign-in is skipped on every message, and repeating that each time would
 * bury the conversation. The same notice again in the same chat is silent; a
 * different one (another plugin, the same one for a new reason) says so once
 * more. Every shown notice also lands in the right-rail Logs.
 */

export interface PluginNoticePlugin {
  pluginId: string;
  name: string;
  displayName: string | null;
  reason: ActivePluginSkipReason;
  /** For a `placement` skip: where the component would have run. */
  placement?: "local" | "computer";
}

/**
 * Why a chat with runnable plugins runs this message without them. Each is a
 * turn that has to stay on this machine's own chat route, which cannot load
 * plugins, or a comparison, whose columns run one plain client turn each.
 */
export type PluginsOffReason =
  "local_harness" | "local_server" | "local_model" | "local_tools" | "compare";

export type PluginNoticeData =
  /** Some installed plugins were skipped; the rest of the turn ran. */
  | { kind: "skipped"; plugins: PluginNoticePlugin[] }
  /** The chat could not be set up to run its plugins; it ran without them. */
  | { kind: "unavailable" }
  /** The chat's plugins are runnable, but this message ran without them. */
  | { kind: "off"; reason: PluginsOffReason };

const REASON_COPY: Record<string, string> = {
  needs_auth: "sign in to its server first",
  needs_setup: "finish its setup first",
  placement: "its server runs on a local runtime",
  not_ready: "its active version isn't ready yet",
  no_active_version: "it has no active version",
  over_cap: "only 10 plugins load per message",
  server_missing: "one of its servers no longer exists",
  skill_unpinnable: "one of its skills can't be loaded",
};

const OFF_COPY: Record<PluginsOffReason, string> = {
  local_harness:
    "Plugins didn't run for this message: it runs the client on this computer.",
  local_server:
    "Plugins didn't run for this message: a selected server runs on this computer.",
  local_model:
    "Plugins didn't run for this message: the selected model uses a key stored on this computer.",
  local_tools:
    "Plugins didn't run for this message: it uses this computer's browser or shell.",
  compare: "Plugins don't run in comparisons yet.",
};

export const PLUGINS_UNAVAILABLE_MESSAGE =
  "Plugins couldn't load for this chat, so it ran without them.";

function noticeLabel(plugin: PluginNoticePlugin): string {
  return plugin.displayName?.trim() || plugin.name;
}

/**
 * A chat never starts a plugin's local process on its own; in a build that
 * could, the member is told that is why, not that it cannot run here.
 */
function placementCopy(plugin: PluginNoticePlugin): string {
  if (plugin.placement === "computer") {
    return "it runs in a computer and isn't started automatically";
  }
  return HOSTED_MODE
    ? REASON_COPY.placement
    : "it runs on this computer and isn't started automatically";
}

function describeSkip(plugin: PluginNoticePlugin): string {
  const reason =
    plugin.reason === "placement"
      ? placementCopy(plugin)
      : (REASON_COPY[plugin.reason] ?? "it couldn't load for this message");
  return `${noticeLabel(plugin)} was skipped: ${reason}.`;
}

/** The plain line a notice reads as. */
export function describePluginNotice(data: PluginNoticeData): string {
  if (data.kind === "unavailable") return PLUGINS_UNAVAILABLE_MESSAGE;
  if (data.kind === "off") return OFF_COPY[data.reason];
  const [first, second, ...rest] = data.plugins;
  if (!first) return PLUGINS_UNAVAILABLE_MESSAGE;
  if (!second) return describeSkip(first);
  if (rest.length === 0)
    return `${describeSkip(first)} ${describeSkip(second)}`;
  return `${describeSkip(first)} ${data.plugins.length - 1} more plugins were skipped; see Logs for details.`;
}

/** Chat id + what the notice says (sorted `pluginId:reason` pairs for skips). */
export function pluginNoticeKey(
  chatSessionId: string,
  data: PluginNoticeData,
): string {
  const signature =
    data.kind === "skipped"
      ? data.plugins
          .map((plugin) => `${plugin.pluginId}:${plugin.reason}`)
          .sort()
          .join(",")
      : data.kind === "off"
        ? `off:${data.reason}`
        : "unavailable";
  return `${chatSessionId}|${signature}`;
}

function logMethod(data: PluginNoticeData): string {
  if (data.kind === "skipped") return "plugins/skipped";
  if (data.kind === "off") return "plugins/off";
  return "plugins/unavailable";
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
  if (data.kind === "skipped" && data.plugins.length === 0) return false;
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
      method: logMethod(data),
      timestamp: new Date().toISOString(),
      payload: {
        level: "warning",
        message,
        chatSessionId,
        ...(data.kind === "skipped"
          ? {
              plugins: data.plugins.map((plugin) => ({
                pluginId: plugin.pluginId,
                name: noticeLabel(plugin),
                reason: plugin.reason,
              })),
            }
          : {}),
        ...(data.kind === "off" ? { reason: data.reason } : {}),
      },
    });
  } catch {
    // Logging must never break the chat that hit the problem.
  }
  return true;
}
