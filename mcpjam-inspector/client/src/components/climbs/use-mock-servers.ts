import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { useProjectServers } from "@/hooks/useProjects";

export type MockServerRow = { id: string; name: string; baseServerId: string | null; headVersion: number };

/**
 * The project's mock servers, by name, and its other servers. Nothing is read
 * while `enabled` is false, so a project without climbs sends no request.
 */
export function useMockServers(projectId: string | null | undefined, enabled: boolean) {
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({
    projectId: enabled ? (projectId ?? null) : null,
    isAuthenticated: enabled && isAuthenticated,
  });
  return useMemo(() => {
    const mocks = new Map<string, MockServerRow>();
    const real: { id: string; name: string }[] = [];
    for (const server of servers ?? []) {
      if (server.lifecycleScope === "mock") {
        mocks.set(server.name, {
          id: server._id,
          name: server.name,
          baseServerId: server.mock?.baseServerId ?? null,
          headVersion: server.mock?.headVersion ?? 1,
        });
      } else {
        real.push({ id: server._id, name: server.name });
      }
    }
    return { mocks, real, loading: servers === undefined };
  }, [servers]);
}
