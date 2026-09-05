import { useEffect, useRef } from "react";
import { useRouteError } from "react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { reportCaught } from "@/lib/error-reporting";
import { scrubSensitiveUrl } from "@/lib/PosthogUtils";
import {
  attemptStaleChunkRecovery,
  isStaleChunkError,
  STALE_CHUNK_MESSAGE,
} from "@/lib/stale-chunk";

const GENERIC_MESSAGE = "An unexpected error occurred";

function errorMessage(error: unknown): string {
  // Every branch goes through `nonEmpty`: an Error with an empty `message`, or
  // a route response with `statusText: ""`, would otherwise render a blank
  // detail line instead of falling through to the generic text.
  const nonEmpty = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;

  if (error instanceof Error) return nonEmpty(error.message) ?? GENERIC_MESSAGE;
  const direct = nonEmpty(error);
  if (direct) return direct;
  if (error && typeof error === "object" && "statusText" in error) {
    const statusText = nonEmpty((error as { statusText: unknown }).statusText);
    if (statusText) return statusText;
  }
  return GENERIC_MESSAGE;
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
  const stale = isStaleChunkError(error);
  // Effect (not render) so StrictMode's double-render and any re-render from a
  // parent can't multiply the report; the ref keeps it to one per error.
  const reported = useRef<unknown>(null);

  useEffect(() => {
    if (reported.current === error) return;
    reported.current = error;
    // Scrubbed: `/results/<token>` is a bearer-credential path, and a crash
    // there would otherwise ship the token straight to Sentry/PostHog —
    // the exact leak the rest of this PR closes elsewhere.
    const pathname = scrubSensitiveUrl(window.location.pathname);

    if (stale) {
      // Warning, not error: the build is fine, this tab is just old. It is
      // still worth a signal — a `cooldown` outcome means the reload did not
      // help, which is a real broken deploy rather than a stale tab.
      const recovery = attemptStaleChunkRecovery();
      reportCaught(error, {
        source: "stale_chunk",
        level: "warning",
        extra: { pathname, recovery, boundary: "route_error_element" },
      });
      return;
    }

    reportCaught(error, {
      source: "route_error_element",
      extra: { pathname },
    });
  }, [error, stale]);

  return (
    <div
      className="flex items-center justify-center min-h-screen p-6"
      data-testid="route-error-screen"
    >
      <div className="text-center max-w-md">
        <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">
          {stale
            ? "A newer version of MCPJam is available"
            : "Something went wrong"}
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {stale ? STALE_CHUNK_MESSAGE : errorMessage(error)}
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
