import type { ServerWithName } from "@/hooks/use-app-state";

/**
 * Explore suites are no longer auto-created from server connections.
 * Keep the hook as a no-op so existing call sites can remain unchanged until
 * they are cleaned up independently.
 */
export function useExploreCasesPrefetchOnConnect(
  _workspaceId: string | null | undefined,
  _server: ServerWithName,
  _hostedServerId?: string | null,
) {}
