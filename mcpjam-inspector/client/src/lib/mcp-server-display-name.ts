import type { RemoteServer } from "@/hooks/useWorkspaces";
import { HOSTED_MODE } from "@/lib/config";
import { tryGetHostedServerDisplayName } from "@/lib/apis/web/context";

/** In comma-separated lists, after “no longer in this workspace: …” */
const REMOVED_SERVER_LIST_LABEL = "a removed server";

function isLikelyOpaqueServerId(ref: string): boolean {
  return ref.length >= 20 && /^[a-z0-9]+$/i.test(ref);
}

/**
 * True when we only have a stored id (or similar) and cannot map it to a
 * current workspace server or hosted name.
 */
export function isUnresolvableMcpServerRef(
  serverRef: string,
  options?: { remoteServers?: RemoteServer[] | undefined },
): boolean {
  const trimmed = serverRef.trim();
  if (!trimmed) {
    return true;
  }

  const { remoteServers } = options ?? {};
  if (remoteServers?.some((s) => s._id === trimmed)) {
    return false;
  }
  if (remoteServers?.some((s) => s.name === trimmed)) {
    return false;
  }
  if (HOSTED_MODE && tryGetHostedServerDisplayName(trimmed)) {
    return false;
  }
  return isLikelyOpaqueServerId(trimmed);
}

/**
 * Returns a human-readable label for an MCP server reference (name, Convex
 * `_id`, or other opaque id), for toasts and inline copy. Prefers workspace
 * registry data, then hosted name↔id mappings, then the raw ref. Unresolvable
 * opaque ids use a generic "removed" phrase instead of exposing long ids.
 */
export function getMcpServerDisplayName(
  serverRef: string,
  options?: { remoteServers?: RemoteServer[] | undefined },
): string {
  const trimmed = serverRef.trim();
  if (!trimmed) {
    return "Unknown server";
  }

  const { remoteServers } = options ?? {};

  const fromRemote = remoteServers?.find((s) => s._id === trimmed);
  if (fromRemote) {
    return fromRemote.name;
  }

  if (HOSTED_MODE) {
    const hosted = tryGetHostedServerDisplayName(trimmed);
    if (hosted) {
      return hosted;
    }
  }

  const fromRemoteByName = remoteServers?.find((s) => s.name === trimmed);
  if (fromRemoteByName) {
    return fromRemoteByName.name;
  }

  if (isLikelyOpaqueServerId(trimmed)) {
    return REMOVED_SERVER_LIST_LABEL;
  }

  return trimmed;
}

type ConnectPromptKind = "suite" | "test-case";

/**
 * Copy for the “no ensureServersReady; user must connect manually” case.
 */
export function formatMcpConnectServerPrompt(
  serverRefs: readonly string[],
  options: { remoteServers?: RemoteServer[] | undefined; kind: ConnectPromptKind },
): string {
  const { remoteServers, kind } = options;
  const opts = { remoteServers };
  if (serverRefs.length > 0 && serverRefs.every((r) => isUnresolvableMcpServerRef(r, opts))) {
    if (kind === "suite") {
      return "Add or reconnect the MCP server this suite needs, then run it.";
    }
    return "Add or reconnect the MCP server this test needs, then run it.";
  }

  return `Connect to ${formatMcpServerRefsForError(serverRefs, opts)} to ${kind === "suite" ? "run this suite" : "run this test case"}.`;
}

export function formatMcpServerRefsForError(
  serverRefs: readonly string[],
  options?: { remoteServers?: RemoteServer[] | undefined },
): string {
  const labels = serverRefs.map((ref) =>
    getMcpServerDisplayName(ref, options),
  );
  return [...new Set(labels)].join(", ");
}
