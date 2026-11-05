import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { useCurrentLocationParts } from "@/lib/app-navigation";
import {
  evaluateAddressDependsOnFlag,
  planEvaluateAddress,
  type EvaluateAddressPlan,
  type IterationLocation,
} from "@/lib/evaluate-legacy-paths";
import {
  EVAL_NAV_ARRIVAL_STATE_KEY,
  trackEvalNav,
  type EvalNavArrivalState,
} from "@/components/evaluate/nav/eval-nav-events";
import { useSettledEvaluateNavFlag } from "@/components/evaluate/nav/use-settled-evaluate-nav-flag";
import { ScopedNavigate } from "./scoped-navigate";

const REDIRECT_ARRIVAL: EvalNavArrivalState = {
  [EVAL_NAV_ARRIVAL_STATE_KEY]: "redirect",
};

type Lookup = { iterationId: string; found: IterationLocation | null };

/** The plan with any iteration lookup done; null while it is in flight. */
function useResolvedPlan(
  plan: EvaluateAddressPlan | null,
): EvaluateAddressPlan | null {
  const convex = useConvex();
  const iterationId = plan?.action === "lookup" ? plan.iterationId : null;
  const [lookup, setLookup] = useState<Lookup | null>(null);

  useEffect(() => {
    if (!iterationId) return;
    let cancelled = false;
    const settle = (found: IterationLocation | null) => {
      if (!cancelled) setLookup({ iterationId, found });
    };
    convex
      .query("testSuites:getTestIteration" as never, { iterationId } as never)
      .then((iteration: IterationLocation | null) =>
        settle(
          iteration
            ? {
                testCaseId: iteration.testCaseId,
                suiteRunId: iteration.suiteRunId,
              }
            : null,
        ),
      )
      // A malformed, deleted or unreadable iteration keeps today's address.
      .catch(() => settle(null));
    return () => {
      cancelled = true;
    };
  }, [convex, iterationId]);

  if (plan?.action !== "lookup") return plan;
  return lookup?.iterationId === plan.iterationId
    ? plan.resolve(lookup.found)
    : null;
}

/**
 * Moves an Evaluate address to the form the flag serves before the page
 * mounts: old addresses to their new pages with the flag on, new addresses to
 * today's pages with it off. Each rewrite, and each old address it cannot
 * map, sends `eval_nav_redirected`.
 */
export function EvaluateAddressRedirect({ children }: { children: ReactNode }) {
  const { pathname, search, hash } = useCurrentLocationParts();
  const enabled = useSettledEvaluateNavFlag();
  const plan = useMemo(
    () =>
      enabled === undefined
        ? null
        : planEvaluateAddress({ pathname, search, hash }, enabled),
    [enabled, pathname, search, hash],
  );
  const waitsForFlag = useMemo(
    () =>
      enabled === undefined &&
      evaluateAddressDependsOnFlag({ pathname, search, hash }),
    [enabled, pathname, search, hash],
  );
  const resolved = useResolvedPlan(plan);

  const reported = useRef<string | null>(null);
  const address = `${pathname}${search}${hash}`;
  const event = resolved?.action === "lookup" ? undefined : resolved?.event;
  useEffect(() => {
    if (!event || reported.current === address) return;
    reported.current = address;
    trackEvalNav("eval_nav_redirected", event);
  }, [address, event]);

  if (waitsForFlag || (plan && !resolved)) return null;
  if (resolved?.action === "redirect") {
    return <ScopedNavigate to={resolved.to} replace state={REDIRECT_ARRIVAL} />;
  }
  return <>{children}</>;
}
