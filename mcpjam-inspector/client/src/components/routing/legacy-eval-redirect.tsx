import { NotFoundRoute } from "./not-found-route";
import { ScopedNavigate } from "./scoped-navigate";
import {
  legacyEvalPathToEvaluatePath,
  useCurrentLocationParts,
} from "@/lib/app-navigation";
import { buildProjectPath, parseProjectPath } from "@/lib/project-route";

/** Redirect before mounting legacy content, so opening a link cannot create data. */
export function LegacyEvalRedirect() {
  const { pathname, search, hash } = useCurrentLocationParts();
  const scoped = parseProjectPath(pathname);
  const target = legacyEvalPathToEvaluatePath(
    scoped?.relativePath ?? pathname,
    search,
    hash,
  );
  const next = scoped ? buildProjectPath(scoped.projectId, target) : target;
  if (next === `${pathname}${search}${hash}`) return <NotFoundRoute />;
  return <ScopedNavigate to={next} replace />;
}
