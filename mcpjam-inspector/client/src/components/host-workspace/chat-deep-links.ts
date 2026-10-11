import { parsePluginDeepLink } from "@/shared/plugin-deep-link";
import type { ThreadAppDeclaration } from "./thread-app-api";
import type { WorkspaceServer } from "./ThreadAppPanel";
import { describeExtensionError, logExtensionEvent } from "./extension-log";

interface DeepLinkOwner {
  servers: readonly WorkspaceServer[];
  entries: Readonly<Record<string, readonly ThreadAppDeclaration[]>>;
  navigateDeepLink: (server: WorkspaceServer, url: string) => Promise<void>;
  /** The host's resolver (`deep-link/resolve`): real plugin IDs, manifest
   * names, published IDs, `server-<id>` for plain servers, `@marketplace`. */
  api?: { resolveDeepLink?: DeepLinkResolver } | null;
}
type DeepLinkResolver = (
  url: string,
  serverIds: readonly string[],
  signal: AbortSignal,
) => Promise<{ serverId: string }>;

/**
 * Which plugin a deep link written in chat opens: the one server whose global
 * entrypoint has the link's tool. The admitted navigation (the same one an
 * App's `ui/open-link` uses) then checks the plugin ID and path.
 */
export function resolveChatDeepLink(
  owner: Pick<DeepLinkOwner, "servers" | "entries">,
  url: string,
): { server: WorkspaceServer } | { error: string } {
  let toolName: string;
  try {
    toolName = parsePluginDeepLink(url).toolName;
  } catch {
    return {
      error:
        "This isn't a valid plugin link. It needs a plugin, an App tool and a path.",
    };
  }
  const candidates = owner.servers.filter((server) =>
    (owner.entries[server.serverId] ?? []).some(
      (entry) => entry.kind === "global" && entry.toolName === toolName,
    ),
  );
  if (!candidates.length)
    return {
      error: `No plugin in this chat has a global App with the tool "${toolName}".`,
    };
  if (candidates.length > 1)
    return {
      error: `Several plugins have a global App with the tool "${toolName}" (${candidates
        .map((server) => server.name)
        .join(", ")}). Open it from the Apps list instead.`,
    };
  return { server: candidates[0] };
}

/** Open a link written in chat; failures are described and logged. */
export async function openChatDeepLink(
  owner: DeepLinkOwner | null,
  url: string,
  report: (message: string) => void,
): Promise<boolean> {
  const fail = (message: string, serverId = "extensions") => {
    report(message);
    logExtensionEvent({
      serverId,
      label: "deep-link",
      level: "error",
      message,
      detail: { url },
    });
    return false;
  };
  if (!owner) return fail("Plugin Apps aren't available in this chat.");
  // Prefer the host's resolver (plugin IDs, manifest names, published IDs,
  // @marketplace, plain servers); fall back to matching the App's tool.
  const resolver = owner.api?.resolveDeepLink;
  let resolved: { server: WorkspaceServer } | { error: string };
  if (typeof resolver === "function") {
    try {
      const { serverId } = await resolver.call(
        owner.api,
        url,
        owner.servers.map((server) => server.serverId),
        AbortSignal.timeout(15_000),
      );
      const server = owner.servers.find((item) => item.serverId === serverId);
      resolved = server
        ? { server }
        : { error: "This link opens a plugin that isn't in this chat." };
    } catch (error) {
      resolved = { error: describeExtensionError(error) };
    }
  } else resolved = resolveChatDeepLink(owner, url);
  if ("error" in resolved) return fail(resolved.error);
  try {
    await owner.navigateDeepLink(resolved.server, url);
    return true;
  } catch (error) {
    return fail(describeExtensionError(error), resolved.server.serverId);
  }
}
