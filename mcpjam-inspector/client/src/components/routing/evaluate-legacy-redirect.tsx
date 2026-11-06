import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { evalNavPlace } from "@/components/evaluate/nav/eval-nav-crumbs";
import { trackEvalNav } from "@/components/evaluate/nav/eval-nav-analytics";
import type { EvalNavLocationState } from "@/components/evaluate/nav/eval-nav-state";
import { useEvaluateNavEnabled } from "@/hooks/useEvaluateNavEnabled";
import {
  buildEvaluatePath,
  useCurrentLocationParts,
} from "@/lib/app-navigation";
import {
  matchLegacyEvaluatePath,
  redirectForIteration,
  type IterationLocation,
  type LegacyEvaluateRedirect,
} from "@/lib/evaluate-legacy-paths";
import { buildProjectPath, parseProjectPath } from "@/lib/project-route";
import { ScopedNavigate } from "./scoped-navigate";

const iterationQuery = makeFunctionReference<
  "query",
  { iterationId: string },
  IterationLocation | null
>("testSuites:getTestIteration");

/**
 * Where an iteration lives: undefined while loading, null when it is missing
 * or unreadable. useQueries hands back a thrown query error as a value, so an
 * id the viewer cannot read falls back instead of reaching the error boundary.
 */
function useIterationLocation(
  iterationId: string | null,
): IterationLocation | null | undefined {
  const queries = useMemo(() => {
    const requests: Parameters<typeof useQueries>[0] = {};
    if (iterationId) {
      requests.iteration = { query: iterationQuery, args: { iterationId } };
    }
    return requests;
  }, [iterationId]);
  const result: unknown = useQueries(queries).iteration;
  if (!iterationId || result === undefined) return undefined;
  if (result instanceof Error || !isIterationLocation(result)) return null;
  return result;
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isIterationLocation(value: unknown): value is IterationLocation {
  if (typeof value !== "object" || value === null) return false;
  return (
    isOptionalId(Reflect.get(value, "suiteRunId")) &&
    isOptionalId(Reflect.get(value, "testCaseId"))
  );
}

function redirectState(redirect: LegacyEvaluateRedirect): EvalNavLocationState {
  const { backTo } = redirect;
  return {
    evalNav: {
      via: "redirect",
      ...(backTo
        ? {
            from: {
              path: buildEvaluatePath(backTo),
              place: evalNavPlace(backTo, {}),
            },
          }
        : {}),
    },
  };
}

/**
 * With evaluate-nav-enabled on, replaces an old Evaluate address with its
 * per-layer page before today's page mounts, so an old editor or drawer never
 * flashes and today's page view never fires for the old address. Renders
 * children otherwise.
 */
export function EvaluateLegacyRedirectGate({
  children,
}: {
  children: ReactNode;
}) {
  const enabled = useEvaluateNavEnabled();
  const { pathname, search, hash } = useCurrentLocationParts();
  const scoped = parseProjectPath(pathname);
  const projectId = scoped?.projectId ?? null;
  const logicalPath = scoped?.relativePath ?? pathname;
  const match = useMemo(
    () => matchLegacyEvaluatePath(logicalPath, search),
    [logicalPath, search],
  );
  const lookup = match.kind === "lookup" ? match.lookup : null;
  const iteration = useIterationLocation(
    enabled === true && lookup ? lookup.iterationId : null,
  );

  const redirect = useMemo(() => {
    if (enabled !== true) return null;
    if (match.kind === "redirect") return match.redirect;
    if (lookup && iteration !== undefined) {
      return redirectForIteration(lookup, iteration);
    }
    return null;
  }, [enabled, match, lookup, iteration]);
  const state = useMemo(
    () => (redirect ? redirectState(redirect) : null),
    [redirect],
  );

  // Once per address, across re-renders and StrictMode's double effects.
  const firedFor = useRef<string | null>(null);
  const addressKey = `${pathname}${search}`;
  const unmatched = enabled === true && match.kind === "unmatched";
  useEffect(() => {
    if (!redirect && !unmatched) return;
    if (firedFor.current === addressKey) return;
    firedFor.current = addressKey;
    trackEvalNav(
      "eval_nav_redirected",
      redirect
        ? {
            from_kind: redirect.fromKind,
            to_kind: redirect.to.type,
            matched: true,
            project_id: projectId,
          }
        : {
            from_kind: "unknown",
            to_kind: null,
            matched: false,
            project_id: projectId,
          },
    );
  }, [addressKey, projectId, redirect, unmatched]);

  if (redirect && state) {
    const target = `${redirect.path}${hash}`;
    return (
      <ScopedNavigate
        to={scoped ? buildProjectPath(scoped.projectId, target) : target}
        replace
        state={state}
      />
    );
  }
  // Keep and unmatched addresses never wait. A redirect or lookup waits for
  // the flag (and the lookup) rather than flashing today's page.
  if (match.kind === "keep" || match.kind === "unmatched") return children;
  if (enabled === false) return children;
  return null;
}
