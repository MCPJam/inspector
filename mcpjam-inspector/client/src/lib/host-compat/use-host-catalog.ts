import { useEffect, useState } from "react";
import {
  fetchHostCompatCatalog,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";

/**
 * Live host-compat catalog for the client, fetched once per page load from
 * the inspector's own proxy (`/api/v1/host-catalog` — same-origin, no CORS,
 * no credentials). `null` = bundled: before the fetch resolves, when it
 * fails, and when the proxy itself fell back (`source: "bundled"` carries the
 * same data the SDK already ships, so recomputing verdicts for it is churn).
 * Verdicts render immediately from the bundled catalog and recompute when
 * live data lands.
 */
export type HostCatalogState = {
  catalog: HostCompatCatalog;
  version: number;
  source: string;
} | null;

let cached: HostCatalogState = null;
let inflight: Promise<HostCatalogState> | null = null;
// Bumped on every reset so a fetch started before a reset can't write `cached`
// after it — otherwise an already-in-flight promise leaks stale state into the
// next test case (the `.then` below unconditionally wrote `cached`).
let generation = 0;

async function loadHostCatalog(): Promise<HostCatalogState> {
  const result = await fetchHostCompatCatalog({
    baseUrl: "/api/v1",
    timeoutMs: 4_000,
  });
  if (!result.ok || result.source === "bundled") return null;
  return {
    catalog: result.catalog,
    version: result.version,
    source: result.source,
  };
}

/** Test hook — reset the module-level memo between cases. */
export function resetHostCatalogForTests(): void {
  cached = null;
  inflight = null;
  generation++;
}

export function useHostCatalog(): HostCatalogState {
  const [state, setState] = useState<HostCatalogState>(cached);

  useEffect(() => {
    if (cached) {
      // The cache may have been populated by another consumer's in-flight
      // fetch between this component's render (which seeded `state` from a
      // then-null `cached`) and this effect. Sync so we don't stay stuck on
      // the bundled catalog while other consumers show live data.
      setState(cached);
      return;
    }
    let mounted = true;
    if (!inflight) {
      const startedGeneration = generation;
      inflight = loadHostCatalog().then((resolved) => {
        // Drop a resolution from a pre-reset fetch (stale generation).
        if (startedGeneration === generation) cached = resolved;
        return resolved;
      });
    }
    void inflight.then((resolved) => {
      if (mounted && resolved) setState(resolved);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
