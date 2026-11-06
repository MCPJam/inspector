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
  type LegacyIterationLookup,
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
  iterationId: string,
): IterationLocation | null | undefined {
  const queries = useMemo(
    () => ({ iteration: { query: iterationQuery, args: { iterationId } } }),
    [iterationId],
  );
  const result: unknown = useQueries(queries).iteration;
  if (result === undefined) return undefined;
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

interface RedirectTarget {
  projectId: string | null;
  hash: string;
}

/** Replaces the address with the redirect's page and reports it once. */
function LegacyRedirect({
  redirect,
  projectId,
  hash,
}: RedirectTarget & { redirect: LegacyEvaluateRedirect }) {
  const state = useMemo(() => redirectState(redirect), [redirect]);
  // A ref survives StrictMode's double effects, so the event fires once.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trackEvalNav("eval_nav_redirected", {
      from_kind: redirect.fromKind,
      to_kind: redirect.to.type,
      matched: true,
      project_id: projectId,
    });
  }, [projectId, redirect]);
  const target = `${redirect.path}${hash}`;
  return (
    <ScopedNavigate
      to={projectId ? buildProjectPath(projectId, target) : target}
      replace
      state={state}
    />
  );
}

/**
 * Reads the iteration only once a lookup is actually needed, so the gate
 * itself never depends on Convex. Renders nothing while it loads.
 */
function IterationLookupRedirect({
  lookup,
  ...target
}: RedirectTarget & { lookup: LegacyIterationLookup }) {
  const iteration = useIterationLocation(lookup.iterationId);
  const redirect = useMemo(
    () =>
      iteration === undefined ? null : redirectForIteration(lookup, iteration),
    [lookup, iteration],
  );
  return redirect ? <LegacyRedirect redirect={redirect} {...target} /> : null;
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

  // Once per unmatched address, across re-renders and StrictMode.
  const reportedUnmatched = useRef<string | null>(null);
  const addressKey = `${pathname}${search}`;
  const unmatched = enabled === true && match.kind === "unmatched";
  useEffect(() => {
    if (!unmatched || reportedUnmatched.current === addressKey) return;
    reportedUnmatched.current = addressKey;
    trackEvalNav("eval_nav_redirected", {
      from_kind: "unknown",
      to_kind: null,
      matched: false,
      project_id: projectId,
    });
  }, [addressKey, projectId, unmatched]);

  // Keep and unmatched addresses never wait.
  if (match.kind === "keep" || match.kind === "unmatched") return children;
  if (enabled === false) return children;
  // A redirect or lookup waits for the flag rather than flashing today's page.
  if (enabled !== true) return null;
  const target = { projectId, hash };
  return match.kind === "redirect" ? (
    <LegacyRedirect redirect={match.redirect} {...target} />
  ) : (
    <IterationLookupRedirect lookup={match.lookup} {...target} />
  );
}
