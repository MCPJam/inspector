import { useEffect, useState } from "react";
import * as ConvexReact from "convex/react";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import * as AppStateContext from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";

/**
 * One-shot probe of a `projectEnvironments:getCapabilities` flag — the
 * deployment's own statement of which optional args its validators accept.
 * Shared by {@link useModelSelectionsCapability} and
 * `useModelMatrixCapability`; see the latter for why this goes through
 * `useConvex().query(...)` in an effect rather than `useQuery`.
 *
 * Returns `undefined` while probing, `true` when advertised, `false` on skew
 * or any failure. Callers treat anything but `true` as "not accepted".
 */
export function useProjectEnvironmentCapability(
  projectId: string | null | undefined,
  flag: "modelMatrix" | "modelSelections",
): boolean | undefined {
  // Named `import { useConvex }` and even `ConvexReact.useConvex` throw
  // when a test mock omits the export (vitest: "No useConvex export is
  // defined"). Catch that so opted-out composers stay "no matrix".
  let convex:
    { query: (name: never, args: never) => Promise<unknown> } | undefined;
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
      .query(
        "projectEnvironments:getCapabilities" as never,
        {
          projectId: normalized,
        } as never,
      )
      .then((caps: unknown) => {
        const advertised =
          caps !== null &&
          typeof caps === "object" &&
          flag in caps &&
          (caps as Record<string, unknown>)[flag] === true;
        if (!cancelled) setState(advertised);
      })
      .catch(() => {
        // Every failure means the same thing to a caller: do not offer the
        // models slot, and do not let the resolver send a `modelId`. Skew (the
        // function is missing) and any other error were previously separate
        // branches setting the identical value.
        if (!cancelled) setState(false);
      });
    return () => {
      cancelled = true;
    };
  }, [convex, projectId, flag]);

  return state;
}

/**
 * Whether this deployment stores a saved model selection beside a legacy model
 * id (`getCapabilities.modelSelections`). Writers send a `ModelSelection` only
 * when this is `true`: an older deployment's validators reject the unknown
 * field, and the save would fail. Anything else ⇒ save the legacy id alone.
 */
export function useModelSelectionsCapability(
  projectId: string | null | undefined,
): boolean | undefined {
  return useProjectEnvironmentCapability(projectId, "modelSelections");
}

/**
 * {@link useModelSelectionsCapability} for a project given as either an
 * inspector-local project key or a Convex project id — defaulting to the
 * active project — resolved the way `useAvailableModels` scopes its org
 * config. Safe outside an `AppStateProvider` (then only an explicit Convex
 * id is probed). `true` only when the deployment advertises the flag.
 */
export function useModelSelectionsSupported(
  projectId?: string | null,
): boolean {
  // Read defensively, like the Convex handle above: a test mock of the app
  // state module may omit this export, and a missing provider is legal.
  let appState: ReturnType<typeof AppStateContext.useOptionalSharedAppState> =
    null;
  try {
    const useOptional = (
      AppStateContext as {
        useOptionalSharedAppState?: typeof AppStateContext.useOptionalSharedAppState;
      }
    ).useOptionalSharedAppState;
    if (typeof useOptional === "function") appState = useOptional();
  } catch {
    appState = null;
  }
  const scopedProjectId = projectId ?? appState?.activeProjectId ?? null;
  const scopedProject = appState
    ? findProjectByAnyId(appState.projects, scopedProjectId)
    : undefined;
  const convexProjectId = scopedProject?.sharedProjectId ?? projectId ?? null;
  return useModelSelectionsCapability(convexProjectId) === true;
}
