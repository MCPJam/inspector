/**
 * Arrival state for the per-layer Evaluate pages.
 *
 * Back remembers the page you left in router state (`location.state.evalNav`),
 * never in the URL: a shared link carries no history, and the breadcrumb is
 * built from the address alone.
 */
import { useCallback, useContext, useMemo } from "react";
import { UNSAFE_LocationContext } from "react-router";
import { buildEvaluatePath, useAppNavigate } from "@/lib/app-navigation";
import type { EvalRoute } from "@/lib/eval-route-types";
import { evalNavPlace, type EvalNavNames } from "./eval-nav-crumbs";

export type EvalNavArrival = "link" | "crumb" | "back" | "redirect";

/** Where a Back button returns: the page you left, with its place label resolved when you left it. */
export interface EvalNavFrom {
  /** Logical path with search, from buildEvaluatePath (no project prefix). */
  path: string;
  /** Place label, e.g. "suite", "Run #4", "test run" (see evalNavPlace). */
  place: string;
}

export interface EvalNavLocationState {
  evalNav: { via: EvalNavArrival; from?: EvalNavFrom };
}

const ARRIVALS: ReadonlySet<unknown> = new Set<EvalNavArrival>([
  "link",
  "crumb",
  "back",
  "redirect",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrival(value: unknown): value is EvalNavArrival {
  return ARRIVALS.has(value);
}

function readFrom(value: unknown): EvalNavFrom | null {
  if (!isRecord(value)) return null;
  const { path, place } = value;
  if (typeof path !== "string" || typeof place !== "string") return null;
  return { path, place };
}

/** Type guard over an unknown location.state; null when absent or malformed. */
export function readEvalNavState(
  state: unknown,
): EvalNavLocationState["evalNav"] | null {
  if (!isRecord(state) || !isRecord(state.evalNav)) return null;
  const { via, from } = state.evalNav;
  if (!isArrival(via)) return null;
  if (from === undefined) return { via };
  const parsedFrom = readFrom(from);
  return parsedFrom ? { via, from: parsedFrom } : null;
}

/** Reads location.state via UNSAFE_LocationContext (works without a Router in tests). */
export function useEvalNavArrival(): {
  via: EvalNavArrival | "direct";
  from: EvalNavFrom | null;
} {
  const locationContext = useContext(UNSAFE_LocationContext);
  const state: unknown = locationContext?.location.state;
  return useMemo(() => {
    const evalNav = readEvalNavState(state);
    return { via: evalNav?.via ?? "direct", from: evalNav?.from ?? null };
  }, [state]);
}

/**
 * Navigate to an eval route carrying nav state. `from` is the page being left;
 * omit it for crumb and back clicks (they never set a new Back target).
 */
export function useEvalNavigate(): (
  to: EvalRoute,
  options: {
    via: EvalNavArrival;
    from?: { route: EvalRoute; names: EvalNavNames };
    replace?: boolean;
  },
) => void {
  const navigate = useAppNavigate();
  return useCallback(
    (to, { via, from, replace }) => {
      const state: EvalNavLocationState = {
        evalNav: {
          via,
          ...(from
            ? {
                from: {
                  path: buildEvaluatePath(from.route),
                  place: evalNavPlace(from.route, from.names),
                },
              }
            : {}),
        },
      };
      navigate(buildEvaluatePath(to), { replace, state });
    },
    [navigate],
  );
}
