import { useEffect, useState } from "react";
import posthog from "posthog-js";
import {
  fetchHostCompatCatalog,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";

/**
 * Live host-compat catalog for the client, fetched once per page load from
 * the inspector's own proxy (`/api/v1/host-catalog` — same-origin, no CORS,
 * no credentials). The status is explicit so product flows can require a live
 * backend catalog while compatibility surfaces can still render from fallback
 * data.
 */
export type HostCatalogState =
  | {
      status: "loading";
      catalog: null;
      version: null;
      source: null;
    }
  | {
      status: "live" | "fallback";
      catalog: HostCompatCatalog;
      version: number;
      source: string;
    }
  | {
      status: "error";
      catalog: null;
      version: null;
      source: null;
    };

type ResolvedHostCatalogState = Exclude<
  HostCatalogState,
  { status: "loading" }
>;

const LOADING_STATE: HostCatalogState = {
  status: "loading",
  catalog: null,
  version: null,
  source: null,
};

function reportHostCatalogDegradation(
  details:
    | {
        status: "fallback";
        source: string;
        version: number;
      }
    | {
        status: "error";
        reason: string;
      }
): void {
  console.warn("[host-catalog] client catalog degraded", details);
  try {
    posthog.capture("host_catalog_degraded", details);
  } catch {
    // Telemetry must not affect catalog loading.
  }
}

let cached: ResolvedHostCatalogState | null = null;
let inflight: Promise<HostCatalogState> | null = null;
// Bumped on every reset so a fetch started before a reset can't write `cached`
// after it — otherwise an already-in-flight promise leaks stale state into the
// next test case (the `.then` below unconditionally wrote `cached`).
let generation = 0;

async function loadHostCatalog(): Promise<HostCatalogState> {
  const result = await fetchHostCompatCatalog({
    baseUrl: "/api/v1",
    timeoutMs: 8_000,
  }).catch(() => ({ ok: false as const, reason: "network" as const }));
  if (!result.ok) {
    reportHostCatalogDegradation({
      status: "error",
      reason: result.reason,
    });
    return {
      status: "error",
      catalog: null,
      version: null,
      source: null,
    };
  }
  if (result.source === "bundled") {
    reportHostCatalogDegradation({
      status: "fallback",
      source: result.source,
      version: result.version,
    });
  }
  return {
    status: result.source === "bundled" ? "fallback" : "live",
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
  const [state, setState] = useState<HostCatalogState>(cached ?? LOADING_STATE);

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
    // Captured once for this effect run so both the module-cache write and the
    // local setState below ignore a resolution from a fetch started before a
    // reset (test isolation) — `mounted` alone only blocks post-unmount writes.
    const effectGeneration = generation;
    if (!inflight) {
      inflight = loadHostCatalog().then((resolved) => {
        if (effectGeneration === generation) {
          cached =
            resolved.status === "loading"
              ? {
                  status: "error",
                  catalog: null,
                  version: null,
                  source: null,
                }
              : resolved;
        }
        return resolved;
      });
    }
    void inflight.then((resolved) => {
      if (mounted && effectGeneration === generation) {
        setState(resolved);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
