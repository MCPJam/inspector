import { HOSTED_MODE } from "@/lib/config";
import { toast } from "@/lib/toast";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type { ActivePluginSkipReason } from "@/lib/plugins/active-plugins-types";
import type { PluginServerSignInRequest } from "./plugin-sign-in";

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
  /** The plugin ran, but without a server whose `reason` this is. */
  partial?: boolean;
  /** The server to sign in to, when signing in is the fix. */
  signIn?: PluginServerSignInRequest;
}

/**
 * Why a chat with runnable plugins runs this message without them. Each is a
 * turn that has to stay on this machine's own chat route, which cannot load
 * plugins.
 */
export type PluginsOffReason =
  "local_harness" | "local_server" | "local_model" | "local_tools";

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

const PARTIAL_COPY: Record<string, string> = {
  needs_auth: "sign in to that server to use it",
  needs_setup: "finish that server's setup to use it",
  unreachable: "that server isn't available right now. Try again later",
};

function describeSkip(plugin: PluginNoticePlugin): string {
  if (plugin.partial) {
    const action = PARTIAL_COPY[plugin.reason] ?? "it isn't available yet";
    return `${noticeLabel(plugin)} ran without one of its servers: ${action}.`;
  }
  const reason =
    plugin.reason === "placement"
      ? placementCopy(plugin)
      : (REASON_COPY[plugin.reason] ?? "it couldn't load for this message");
  return `${noticeLabel(plugin)} was skipped: ${reason}.`;
}

/** The plugins a skipped notice names: up to two, or the first of more. */
function namedPlugins(
  plugins: readonly PluginNoticePlugin[],
): readonly PluginNoticePlugin[] {
  return plugins.length <= 2 ? plugins : plugins.slice(0, 1);
}

/** The plain line a notice reads as. */
export function describePluginNotice(data: PluginNoticeData): string {
  if (data.kind === "unavailable") return PLUGINS_UNAVAILABLE_MESSAGE;
  if (data.kind === "off") return OFF_COPY[data.reason];
  const named = namedPlugins(data.plugins);
  if (named.length === 0) return PLUGINS_UNAVAILABLE_MESSAGE;
  const text = named.map(describeSkip).join(" ");
  return named.length === data.plugins.length
    ? text
    : `${text} ${data.plugins.length - 1} more plugins were skipped; see Logs for details.`;
}

/** Chat, skip reason and the permissions its Sign in action will request. */
export function pluginNoticeKey(
  chatSessionId: string,
  data: PluginNoticeData,
): string {
  const signature =
    data.kind === "skipped"
      ? data.plugins
          .map(
            (plugin) =>
              `${plugin.pluginId}:${plugin.reason}${plugin.partial ? ":partial" : ""}${plugin.signIn?.scopeChallenge ? `:${JSON.stringify(plugin.signIn)}` : ""}`,
          )
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

type PluginSignIn = (binding: PluginServerSignInRequest) => void;
let signInHandler: PluginSignIn | null = null;

/**
 * The Playground's Sign in for a plugin's server (`usePluginServerSignIn`),
 * offered on a notice that names a server to sign in to. Returns the
 * unregister, which leaves a newer registration in place.
 */
export function registerPluginNoticeSignIn(handler: PluginSignIn): () => void {
  signInHandler = handler;
  return () => {
    if (signInHandler === handler) signInHandler = null;
  };
}

/**
 * One button signs in to one server, so it is offered only when exactly one
 * plugin in the notice needs a sign-in and the text names that plugin.
 */
function signInAction(data: PluginNoticeData) {
  const handler = signInHandler;
  if (!handler || data.kind !== "skipped") return undefined;
  const needing = data.plugins.filter((plugin) => plugin.signIn);
  const [plugin] = needing;
  const binding = plugin?.signIn;
  if (needing.length !== 1 || !binding) return undefined;
  if (!namedPlugins(data.plugins).includes(plugin)) return undefined;
  return { action: { label: "Sign in", onClick: () => handler(binding) } };
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
  const withSignIn = signInAction(data);
  if (withSignIn) toast.info(message, withSignIn);
  else toast.info(message);
  try {
    useTrafficLogStore.getState().addMcpServerLog({
      id: `plugins:notice:${crypto.randomUUID()}`,
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
                ...(plugin.partial ? { partial: true } : {}),
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
