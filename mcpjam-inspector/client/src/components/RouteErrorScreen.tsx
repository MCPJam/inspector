import { useEffect, useRef } from "react";
import { useRouteError } from "react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { reportCaught } from "@/lib/error-reporting";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "statusText" in error &&
    typeof (error as { statusText: unknown }).statusText === "string"
  ) {
    return (error as { statusText: string }).statusText;
  }
  return "An unexpected error occurred";
}

/**
 * `errorElement` for the root route.
 *
 * react-router's data router catches route render errors itself and renders
 * the nearest `errorElement` — the throw never propagates to a React error
 * boundary above `<RouterProvider>`. Without this, a route-level crash blanked
 * the app and reported nothing. The root `<ErrorBoundary name="root">` in
 * main.tsx still covers the other half: crashes in the providers that wrap the
 * router.
 */
export function RouteErrorScreen() {
  const error = useRouteError();
  // Effect (not render) so StrictMode's double-render and any re-render from a
  // parent can't multiply the report; the ref keeps it to one per error.
  const reported = useRef<unknown>(null);

  useEffect(() => {
    if (reported.current === error) return;
    reported.current = error;
    reportCaught(error, {
      source: "route_error_element",
      extra: { pathname: window.location.pathname },
    });
  }, [error]);

  return (
    <div
      className="flex items-center justify-center min-h-screen p-6"
      data-testid="route-error-screen"
    >
      <div className="text-center max-w-md">
        <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {errorMessage(error)}
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={() => location.reload()} variant="outline">
            Reload
          </Button>
          <Button
            onClick={() => {
              location.href = "/";
            }}
            variant="ghost"
          >
            Go home
          </Button>
        </div>
      </div>
    </div>
  );
}
