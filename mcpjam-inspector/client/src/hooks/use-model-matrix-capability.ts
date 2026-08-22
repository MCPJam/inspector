import { useEffect, useState } from "react";
import * as ConvexReact from "convex/react";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * One-shot probe of `projectEnvironments:getCapabilities.modelMatrix`.
 *
 * Lives in its own module so tests that mock `@/hooks/useProjectEnvironments`
 * do not have to list this export — a missing named export on that mock
 * would otherwise crash every composer consumer (swarm, User Testing).
 *
 * `convex/react`'s `useQuery` throws during render on a missing function, so
 * this MUST go through `useConvex().query(...)` in an effect and catch
 * `/could not find public function/i` — the same probe as `isAdhocUnavailable`.
 *
 * Returns:
 *  - `undefined` while probing (hide the models slot)
 *  - `true` when the backend advertises the matrix
 *  - `false` on skew or any other failure (hide the slot; resolver must
 *    refuse to send `modelId`)
 */
export function useModelMatrixCapability(
  projectId: string | null | undefined
): boolean | undefined {
  // Named `import { useConvex }` and even `ConvexReact.useConvex` throw
  // when a test mock omits the export (vitest: "No useConvex export is
  // defined"). Catch that so opted-out composers stay "no matrix".
  let convex: { query: (name: never, args: never) => Promise<unknown> } | undefined;
  try {
    const useConvex = (ConvexReact as { useConvex?: () => typeof convex })
      .useConvex;
    if (typeof useConvex === "function") {
      convex = useConvex();
    }
  } catch {
    convex = undefined;
  }
  const [state, setState] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const normalized = projectId?.trim() || null;
    if (!normalized || !shouldQueryProjectId(normalized) || !convex) {
      setState(convex ? undefined : false);
      return;
    }
    let cancelled = false;
    setState(undefined);
    void convex
      .query("projectEnvironments:getCapabilities" as never, {
        projectId: normalized,
      } as never)
      .then((caps: { modelMatrix?: boolean } | null) => {
        if (!cancelled) setState(caps?.modelMatrix === true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const data = (err as { data?: unknown } | null)?.data;
        const message =
          typeof data === "string"
            ? data
            : err instanceof Error
              ? err.message
              : String(err);
        if (/could not find public function/i.test(message)) {
          setState(false);
          return;
        }
        setState(false);
      });
    return () => {
      cancelled = true;
    };
  }, [convex, projectId]);

  return state;
}
