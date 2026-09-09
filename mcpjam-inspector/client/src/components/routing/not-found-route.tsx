import { Button } from "@mcpjam/design-system/button";
import { routePaths, useAppNavigate } from "@/lib/app-navigation";

/**
 * An explicit 404.
 *
 * The catch-all used to render Servers. An unknown URL therefore showed a
 * valid-looking screen for whatever project the viewer happened to be parked
 * on — a typo, a truncated link, or a route deleted in a later release all
 * looked like a successful navigation, and nothing anywhere said otherwise.
 */
export function NotFoundRoute() {
  const navigate = useAppNavigate();
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="route-not-found"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">Page not found</p>
        <p className="max-w-md text-sm text-muted-foreground">
          This URL doesn&apos;t match anything in the app. It may have moved, or
          the link may be incomplete.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => navigate(routePaths.root)}
      >
        Go home
      </Button>
    </div>
  );
}
