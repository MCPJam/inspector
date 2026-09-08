import { Outlet } from "react-router";
import { AlertTriangle } from "lucide-react";
import LoadingScreen from "@/components/LoadingScreen";
import { Button } from "@mcpjam/design-system/button";
import { useAppRouteContext } from "@/lib/app-route-context";
import { routePaths, useAppNavigate } from "@/lib/app-navigation";
import type { ProjectRouteState } from "@/lib/project-route-state";

/**
 * The gate on `/p/:projectId`.
 *
 * A project route renders ONLY once the active project equals the one in the
 * URL. Everything below it reads "the active project" from app state, so
 * rendering a screen while those two disagree shows one project's data under
 * another project's address — the exact confusion canonical URLs exist to
 * remove.
 *
 * The failure state is deliberately singular and vague. Deleted, never
 * existed, and belongs to someone else are ONE message: distinguishing them
 * would turn this page into an oracle for which project ids are real.
 */
export function ProjectRouteBoundary() {
  const context = useAppRouteContext();
  const state = context?.projectRouteState as ProjectRouteState | undefined;

  // No coordinator state yet (the very first commit, or a test mounting this
  // without App). Resolving is the safe reading: it renders nothing
  // project-owned.
  if (!state || state.status === "resolving" || state.status === "unscoped") {
    return <LoadingScreen />;
  }

  if (state.status === "inaccessible") {
    return <ProjectRouteInaccessible />;
  }

  return <Outlet context={context} />;
}

/**
 * One generic state for every way a project URL can fail to resolve.
 *
 * It keeps the requested URL in the address bar on purpose: silently
 * redirecting to another project is how a user ends up acting on data they
 * never asked for, and keeping the URL means a reload after being granted
 * access just works.
 */
export function ProjectRouteInaccessible() {
  const navigate = useAppNavigate();
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="project-route-inaccessible"
    >
      <AlertTriangle className="h-6 w-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">This project isn&apos;t available</p>
        <p className="max-w-md text-sm text-muted-foreground">
          It may have been deleted, or you may not have access to it. Pick a
          project from the switcher to keep working.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        // `unscoped`: the way out of an unavailable project must not inherit
        // that project, or this button navigates straight back into the state
        // it is offering to escape.
        onClick={() => navigate(routePaths.root, { unscoped: true })}
      >
        Go to your projects
      </Button>
    </div>
  );
}
