import { useEffect, useState } from "react";
import * as ConvexReact from "convex/react";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/** What `projectEnvironments:getCapabilities` advertises (fields read here). */
export type EnvironmentCapabilities = {
  /** `deriveEnvironments` / `testSuites:deriveSuiteEnvironments`. */
  environmentDerivation?: boolean;
  environmentQuickRuns?: boolean;
  ephemeralEnvironmentLaunch?: boolean;
  modelMatrix?: boolean;
};

/**
 * One-shot probe of `projectEnvironments:getCapabilities`, the same way
 * `useModelMatrixCapability` probes it: through `useConvex().query` in an
 * effect, because `useQuery` throws during render on a function an older
 * backend does not have.
 *
 * Returns `undefined` while probing, the capabilities on success, and `null`
 * on skew or any other failure (a caller then keeps its conservative path).
 */
export function useEnvironmentCapabilities(
  projectId: string | null | undefined,
): EnvironmentCapabilities | null | undefined {
  // A test mock may omit `useConvex`; treat that as "no capabilities".
  let convex:
    { query: (name: never, args: never) => Promise<unknown> } | undefined;
  try {
    const useConvex = (ConvexReact as { useConvex?: () => typeof convex })
      .useConvex;
    if (typeof useConvex === "function") convex = useConvex();
  } catch {
    convex = undefined;
  }
  const [state, setState] = useState<
    EnvironmentCapabilities | null | undefined
  >(undefined);

  useEffect(() => {
    const normalized = projectId?.trim() || null;
    if (!normalized || !shouldQueryProjectId(normalized) || !convex) {
      // Nothing to probe: callers take their conservative path rather than
      // wait on an answer that never comes.
      setState(null);
      return;
    }
    let cancelled = false;
    setState(undefined);
    void convex
      .query(
        "projectEnvironments:getCapabilities" as never,
        {
          projectId: normalized,
        } as never,
      )
      .then((caps: unknown) => {
        if (cancelled) return;
        setState(
          caps !== null && typeof caps === "object"
            ? (caps as EnvironmentCapabilities)
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [convex, projectId]);

  return state;
}
