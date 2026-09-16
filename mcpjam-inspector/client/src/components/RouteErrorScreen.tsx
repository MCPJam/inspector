import { useEffect, useRef } from "react";
import { useRouteError } from "react-router";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { isAuthorizationRefusal } from "@/lib/authorization-refusal";
import { reportCaught } from "@/lib/error-reporting";
import { scrubSensitiveUrl } from "@/lib/PosthogUtils";

const GENERIC_MESSAGE = "An unexpected error occurred";

/**
 * What a non-member sees instead of a stack trace (BB-250).
 *
 * DELIBERATELY AMBIGUOUS between "does not exist" and "exists but is not
 * yours". The backend goes out of its way to give one opaque answer for both —
 * `resolveAuthorizedChatSession` documents that its message must not let a
 * probe enumerate session ids — and copy that said "this swarm belongs to
 * another project" would hand back the existence oracle the backend just
 * closed. The disjunction is the point, not vagueness for its own sake.
 *
 * No resource noun for the same reason: this is the ROOT error element, it
 * catches sessions, personas and swarms alike, and naming the thing the URL
 * asked for would confirm the id resolved to something.
 */
const ACCESS_DENIED_HEADING = "You don't have access to this";
const ACCESS_DENIED_BODY =
  "It belongs to a project you're not a member of, or it no longer exists. " +
  "If someone shared this link with you, ask them to invite you to the project.";

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
  const refused = isAuthorizationRefusal(error);
  // Effect (not render) so StrictMode's double-render and any re-render from a
  // parent can't multiply the report; the ref keeps it to one per error.
  const reported = useRef<unknown>(null);

  useEffect(() => {
    // `reportCaught` drops refusals itself, so this is belt-and-braces — but
    // it keeps the two halves of the fix legible in one place, and it means a
    // future widening of the reporting gate cannot quietly start paging for
    // the case this screen exists to handle.
    if (refused) return;
    if (reported.current === error) return;
    reported.current = error;
    reportCaught(error, {
      source: "route_error_element",
      // Scrubbed: `/results/<token>` is a bearer-credential path, and a crash
      // there would otherwise ship the token straight to Sentry/PostHog —
      // the exact leak the rest of this PR closes elsewhere.
      extra: { pathname: scrubSensitiveUrl(window.location.pathname) },
    });
  }, [error, refused]);

  const goHome = () => {
    location.href = "/";
  };

  if (refused) {
    return (
      <div
        className="flex items-center justify-center min-h-screen p-6"
        data-testid="route-access-denied-screen"
      >
        <div className="text-center max-w-md">
          <Lock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">
            {ACCESS_DENIED_HEADING}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {ACCESS_DENIED_BODY}
          </p>
          {/*
            No Reload. Membership will not change between two clicks, so the
            button's only honest outcome is the same screen again — and a retry
            affordance on a settled refusal invites the loop where one person
            generates a run of identical events.
          */}
          <div className="flex items-center justify-center">
            <Button onClick={goHome} variant="outline">
              Go home
            </Button>
          </div>
        </div>
      </div>
    );
  }

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
          <Button onClick={goHome} variant="ghost">
            Go home
          </Button>
        </div>
      </div>
    </div>
  );
}
