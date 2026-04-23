import type { ServerWithName } from "@/hooks/use-app-state";

/**
 * Explore suites are now auto-created from the Playground tab (EvalsTab) rather
 * than from individual server connection cards. Keep the hook as a no-op so
 * existing call sites can remain unchanged until they are cleaned up independently.
 */
export function useExploreCasesPrefetchOnConnect(
  _workspaceId: string | null | undefined,
  _server: ServerWithName,
  _hostedServerId?: string | null,
) {}
