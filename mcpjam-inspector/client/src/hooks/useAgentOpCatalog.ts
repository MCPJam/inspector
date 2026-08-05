import { useEffect, useState } from "react";
import { authFetch } from "@/lib/session-token";
import type { AgentOpCatalogEntry } from "@/hooks/useOrgSlackSettings";

/**
 * The agent's operation registry, read from the inspector server.
 *
 * FETCHED, NOT HARDCODED. A constant list in the client bundle would drift
 * from `server/routes/v1/agent-op-registry.ts` silently and in both directions:
 * a tool added there would have no toggle, and a tool removed there would
 * leave a toggle that claims to disable something and does not.
 *
 * Cached for the page's lifetime — the registry is build metadata and cannot
 * change between two requests from the same client.
 */
let cachedCatalog: AgentOpCatalogEntry[] | null = null;

/** Test helper: drop the module-level cache. */
export function clearAgentOpCatalogCache(): void {
  cachedCatalog = null;
}

export interface UseAgentOpCatalogResult {
  operations: AgentOpCatalogEntry[] | undefined;
  isLoading: boolean;
  error: string | null;
}

export function useAgentOpCatalog(enabled = true): UseAgentOpCatalogResult {
  const [operations, setOperations] = useState<
    AgentOpCatalogEntry[] | undefined
  >(() => cachedCatalog ?? undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (cachedCatalog) {
      setOperations(cachedCatalog);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    authFetch("/api/v1/agent-ops", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`agent-ops ${response.status}`);
        const body = (await response.json()) as {
          operations?: AgentOpCatalogEntry[];
        };
        const items = Array.isArray(body.operations) ? body.operations : [];
        cachedCatalog = items;
        if (!cancelled) setOperations(items);
      })
      .catch((nextError) => {
        if (cancelled || controller.signal.aborted) return;
        // HARD-FAIL, unlike the harness tool list. An empty catalog here is
        // indistinguishable from "your org has no agent tools", and an admin
        // reading that would conclude the feature is off rather than that the
        // page failed to load.
        setError(
          nextError instanceof Error ? nextError.message : String(nextError)
        );
        setOperations(undefined);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled]);

  return { operations, isLoading, error };
}
