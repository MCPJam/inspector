/**
 * The harness each host runs, for the model pickers that must disable the
 * models a harness cannot run (`lib/harness-model-locks.ts`).
 *
 * The host LIST query does not carry `harness`, so this reads each host's
 * config — one subscription per host, over the handful of hosts a picker shows.
 * An unanswered or failed read (including an id that is not a real host, such
 * as a catalog slug) is `undefined` ("not known yet"), which the lock
 * helpers treat like an emulated host: nothing is disabled on a guess, and the
 * server's admission still refuses what the picker could not see.
 */
import { useCallback, useMemo } from "react";
import { useConvex, useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { HostDetail } from "@/hooks/useClients";
import type { HarnessModelTarget } from "@/lib/harness-model-locks";

const getHostQuery = makeFunctionReference<
  "query",
  { hostId: string },
  HostDetail | null
>("hosts:getHost");

/** `hostId` → the host's harness target, `null` for an emulated host, or
 *  absent while unknown. */
export function useHostHarnessTargets(
  hostIds: readonly string[],
): Record<string, HarnessModelTarget | null> {
  const isUserReady = useDbUserReady();
  const key = isUserReady
    ? [...new Set(hostIds.map((id) => id.trim()).filter(Boolean))]
        .sort()
        .join(",")
    : "";
  const queries = useMemo<Parameters<typeof useQueries>[0]>(() => {
    const request: Parameters<typeof useQueries>[0] = {};
    for (const hostId of key ? key.split(",") : []) {
      request[hostId] = { query: getHostQuery, args: { hostId } };
    }
    return request;
  }, [key]);
  const results = useQueries(queries);

  return useMemo(() => {
    const byHost: Record<string, HarnessModelTarget | null> = {};
    for (const hostId of key ? key.split(",") : []) {
      const result = results[hostId] as HostDetail | null | Error | undefined;
      if (!result || result instanceof Error) continue;
      const harness = result.config?.harness;
      byHost[hostId] = harness ? { harnessId: harness } : null;
    }
    return byHost;
  }, [key, results]);
}

/**
 * An imperative read of one host's harness, for code that learns which hosts
 * matter only at call time (the composer resolver). A failed read degrades to
 * `null` (emulated): nothing is skipped on a guess, and the run admission
 * still refuses an incompatible pair.
 */
export function useHostHarnessLoader(): (
  hostId: string,
) => Promise<HarnessModelTarget | null> {
  const convex = useConvex();
  return useCallback(
    async (hostId: string) => {
      try {
        const host = await convex.query(getHostQuery, { hostId });
        const harness = host?.config?.harness;
        return harness ? { harnessId: harness } : null;
      } catch {
        return null;
      }
    },
    [convex],
  );
}
