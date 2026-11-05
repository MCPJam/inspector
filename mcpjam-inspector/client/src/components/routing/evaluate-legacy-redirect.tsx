import { useEffect, useMemo, type ReactNode } from "react";
import { ScopedNavigate } from "./scoped-navigate";
import { EVAL_NAV_ARRIVAL_STATE_KEY } from "../evaluate/nav/evaluate-nav-host";
import { trackEvalNav } from "../evaluate/nav/evaluate-nav-events";
import { useEvaluateNavEnabled } from "../evaluate/nav/use-evaluate-nav-enabled";
import { useCurrentLocationParts } from "@/lib/app-navigation";
import { resolveEvaluateRedirect } from "@/lib/evaluate-legacy-paths";
import { buildProjectPath, parseProjectPath } from "@/lib/project-route";

const REDIRECT_STATE = { [EVAL_NAV_ARRIVAL_STATE_KEY]: "redirect" };

/**
 * Rewrites an Evaluate address to the form the flag calls for before the
 * page mounts: old links to the new pages with the flag on, new links to
 * today's pages with it off (E4). Records each rewrite and each Evaluate
 * address no row matches.
 */
export function EvaluateLegacyRedirect({ children }: { children: ReactNode }) {
  const { pathname, search, hash } = useCurrentLocationParts();
  const navEnabled = useEvaluateNavEnabled();
  const scoped = parseProjectPath(pathname);
  const decision = useMemo(
    () =>
      resolveEvaluateRedirect({
        pathname: scoped?.relativePath ?? pathname,
        search,
        hash,
        navEnabled,
      }),
    [scoped?.relativePath, pathname, search, hash, navEnabled],
  );
  const event =
    decision.kind === "redirect" || decision.kind === "unmatched"
      ? decision.event
      : null;

  useEffect(() => {
    if (event) trackEvalNav("eval_nav_redirected", event);
  }, [event]);

  if (decision.kind === "wait") return null;
  if (decision.kind !== "redirect") return <>{children}</>;
  const to = scoped
    ? buildProjectPath(scoped.projectId, decision.to)
    : decision.to;
  return <ScopedNavigate to={to} replace state={REDIRECT_STATE} />;
}
