import { useContext, useEffect } from "react";
import { Navigate, UNSAFE_NavigationContext } from "react-router";
import {
  scopeNavigationTarget,
  useAppNavigate,
  useCurrentPathname,
} from "@/lib/app-navigation";

/**
 * `<Navigate>` that keeps the project it was rendered in.
 *
 * A flag-gated project screen that bounces to `/servers` with a plain
 * `<Navigate>` leaves the `/p/:projectId` sub-tree entirely: the browser lands
 * on the unscoped legacy route, which re-resolves a project from persisted
 * state. Usually the same one — but "usually" is not what a URL contract is
 * for, and it costs a second redirect every time.
 *
 * Global and public targets pass through untouched, so this is safe to use for
 * any in-app redirect.
 *
 * It also survives the no-Router render path, which `<Navigate>` alone does
 * not: App has a real one (local mode and a good many component tests), and
 * `<Navigate>` throws outside a Router — turning a gated screen into a blank
 * app. There it navigates imperatively instead. The pathname comes from
 * `useCurrentPathname` for the same reason: `useLocation()` throws too.
 */
export function ScopedNavigate({
  to,
  replace,
}: {
  to: string;
  replace?: boolean;
}) {
  const pathname = useCurrentPathname();
  const navigate = useAppNavigate();
  const hasRouter = Boolean(useContext(UNSAFE_NavigationContext));
  const target = scopeNavigationTarget(to, pathname);

  useEffect(() => {
    if (hasRouter) return;
    navigate(target, { replace });
  }, [hasRouter, navigate, target, replace]);

  if (!hasRouter) return null;
  return <Navigate to={target} replace={replace} />;
}
