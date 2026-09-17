import { Navigate, useLocation } from "react-router";
import { legacyEvalCasePathToEvaluatePath } from "@/lib/app-navigation";
import { buildProjectPath, parseProjectPath } from "@/lib/project-route";
import { NotFoundRoute } from "./not-found-route";

export function LegacyEvalCaseRedirect() {
  // Loader Requests omit fragments; router location preserves them for both
  // bookmarks and client-side navigation (unlike window.location).
  const { pathname, search, hash } = useLocation();
  const scoped = parseProjectPath(pathname);
  const target = legacyEvalCasePathToEvaluatePath(
    scoped ? scoped.relativePath : pathname,
    search,
    hash,
  );
  const next = scoped ? buildProjectPath(scoped.projectId, target) : target;
  if (next === `${pathname}${search}${hash}`) return <NotFoundRoute />;
  return <Navigate to={next} replace />;
}
