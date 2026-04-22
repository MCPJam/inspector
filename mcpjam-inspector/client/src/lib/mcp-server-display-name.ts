import type { RemoteServer } from "@/hooks/useWorkspaces";
import { HOSTED_MODE } from "@/lib/config";
import { tryGetHostedServerDisplayName } from "@/lib/apis/web/context";

const REMOVED_SERVER_LABEL = "A server that is no longer in this workspace";

function isLikelyOpaqueServerId(ref: string): boolean {
  return ref.length >= 20 && /^[a-z0-9]+$/i.test(ref);
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
    return REMOVED_SERVER_LABEL;
  }

  return trimmed;
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
