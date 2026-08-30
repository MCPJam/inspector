import { useEffect, useRef, type ReactNode } from "react";
import LoadingScreen from "@/components/LoadingScreen";
import { useAppRouteContext } from "@/lib/app-route-context";
import { useAppNavigate, useCurrentLocationParts } from "@/lib/app-navigation";
import {
  canonicalizeLegacyProjectTarget,
  hasLegacyProjectQuery,
  isProjectIdShape,
  isProjectScopedPath,
  readLegacyProjectQuery,
  stripLegacyProjectQuery,
} from "@/lib/project-route";
import {
  trackLegacyProjectNormalization,
  trackProjectRouteScopeMismatch,
} from "@/lib/project-route-telemetry";

/**
 * Dual-read compatibility for every URL minted before project scope existed.
 *
 * Two shapes arrive here: a bare project path (`/servers`, `/evals/suite/X`)
 * and the `?project=<id>` convention (`/evals/suite/X?project=A&view=runs`).
 * Both normalize, with `replace`, onto `/p/<id>/...` — the query field is the
 * only thing dropped, and it is dropped whether it appears once or five times.
 *
 * It renders a NORMALIZER, never the destination screen. That is the point:
 * these paths used to render the real screen against whatever project the
 * viewer was parked on, so a link to project A briefly (or permanently)
 * showed project B's data. Nothing project-owned renders until the URL says
 * which project it belongs to.
 *
 * The fallback matters as much as the redirect. A viewer with no project at
 * all — first run, a local inspector with no Convex, a signed-out guest —
 * renders `children` unscoped. Onboarding must not be held behind a project
 * that will never resolve, and `/p/none/...` is not a URL this app will mint.
 */
export function LegacyProjectRouteNormalizer({
  children,
}: {
  children: ReactNode;
}) {
  const navigate = useAppNavigate();
  const context = useAppRouteContext();
  const activeProjectId = context?.activeProjectId as string | null | undefined;
  const isAuthLoading = Boolean(context?.isAuthLoading);
  const isAuthenticated = Boolean(context?.isAuthenticated);
  const isLoadingRemoteProjects = Boolean(context?.isLoadingRemoteProjects);

  const { pathname, search, hash } = useCurrentLocationParts();

  // A path that is already canonical has nothing to normalize. The router
  // never routes one here (scoped paths match the `p/:projectId` sub-tree),
  // so this is a belt-and-braces stop against rewriting a good URL onto the
  // viewer's default project.
  const alreadyCanonical = isProjectScopedPath(pathname);

  const queryProjectId = readLegacyProjectQuery(search);
  const carriesProjectQuery = hasLegacyProjectQuery(search);
  // A `?project=` id the sender chose beats the viewer's persisted default:
  // that parameter is the whole reason the link was minted the old way.
  const targetProjectId = alreadyCanonical
    ? null
    : queryProjectId ??
      (isProjectIdShape(activeProjectId) ? activeProjectId : null);

  // A project that has not resolved YET is not the same as no project. Only
  // the second one may fall through to an unscoped render.
  const isResolving =
    !alreadyCanonical &&
    !targetProjectId &&
    (isAuthLoading || (isAuthenticated && isLoadingRemoteProjects));

  // Redirect-loop protection. If normalizing ever produced a URL that landed
  // back here, the app would pin the CPU rewriting the same path; bail out to
  // an unscoped render and say so in telemetry instead.
  const redirectCountRef = useRef(0);
  const loopedRef = useRef(false);

  useEffect(() => {
    if (loopedRef.current) return;
    if (targetProjectId) {
      if (redirectCountRef.current >= 3) {
        loopedRef.current = true;
        trackProjectRouteScopeMismatch("redirect-loop");
        return;
      }
      redirectCountRef.current += 1;
      trackLegacyProjectNormalization({
        source: queryProjectId ? "query" : "unscoped",
        resolved: true,
      });
      navigate(
        canonicalizeLegacyProjectTarget({
          logicalTarget: `${pathname}${search}${hash}`,
          projectId: targetProjectId,
        }),
        { replace: true }
      );
      return;
    }
    if (isResolving || alreadyCanonical) return;
    // No project to scope to, and a `?project=` we cannot use (malformed, or
    // pointing at nothing this viewer can see). Strip it so it neither
    // lingers in the address bar nor suppresses first-run onboarding, and let
    // the unscoped screen render.
    if (carriesProjectQuery) {
      trackLegacyProjectNormalization({
        source: "query",
        resolved: false,
      });
      navigate(`${pathname}${stripLegacyProjectQuery(search)}${hash}`, {
        replace: true,
      });
    }
  }, [
    alreadyCanonical,
    carriesProjectQuery,
    hash,
    isResolving,
    navigate,
    pathname,
    queryProjectId,
    search,
    targetProjectId,
  ]);

  if (targetProjectId && !loopedRef.current) return <LoadingScreen />;
  if (isResolving) return <LoadingScreen />;
  return <>{children}</>;
}
