import { useEffect, useRef } from "react";
import { useRouteError } from "react-router";
import { AlertTriangle, Lock, LogIn } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import { isAuthorizationRefusal } from "@/lib/authorization-refusal";
import { reportCaught } from "@/lib/error-reporting";
import { scrubSensitiveUrl } from "@/lib/PosthogUtils";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { track } from "@/lib/analytics";

const GENERIC_MESSAGE = "An unexpected error occurred";

/**
 * What a signed-in non-member sees instead of a stack trace (BB-250).
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

/**
 * What a SIGNED-OUT visitor sees instead of the copy above.
 *
 * "Ask them to invite you" is wrong advice for someone who is merely logged
 * out: they may already be a member of the project and one sign-in away from
 * the page, and the invite copy sends them to bother a colleague instead —
 * with `Go home` as the only control on screen, it is also a dead end.
 *
 * A guest reaches this screen TODAY, without waiting on the backend PR:
 * `requireUserActor` already raises `kind: 'forbidden'` for a non-user actor,
 * so `isAuthorizationRefusal` matches an unauthenticated refusal on `main`
 * as it stands.
 *
 * Still says nothing about the resource. "Sign in" reveals no more than the
 * membership copy does — it is a statement about the VIEWER, not the target —
 * so the enumeration property above is preserved.
 */
const SIGN_IN_HEADING = "Sign in to continue";
const SIGN_IN_BODY =
  "You're not signed in, so we can't tell whether this is yours to see. " +
  "Sign in and you'll come straight back here.";

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
  // Safe here: only the final branch of `main.tsx` renders `AppRouterProvider`,
  // and it sits inside `<AuthKitProvider>`. The branches that mount without
  // AuthKit (iframe shell, connection handoff, the plan-limit preview, the
  // OAuth debug popup) render their own components and never the router, so
  // this hook cannot run outside a provider.
  const { user, isLoading, signIn } = useAuth();

  // Which advice is correct depends on the VIEWER, not on which backend helper
  // refused — a signed-out visitor needs to sign in whether the refusal came
  // from `requireUserActor` or from a membership check. Branching on auth state
  // rather than on the refusal's prose also keeps this screen from matching
  // backend message strings across a repo boundary.
  //
  // `isLoading` counts as "not yet signed out": AuthKit reports no user while
  // it is still resolving a session, and showing a signed-in member a sign-in
  // button is the worse of the two wrong answers.
  const needsSignIn = refused && !isLoading && !user;
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

  if (needsSignIn) {
    // Same wiring as `GuestSignInMessage` and the header's sign-in control:
    // capture the return path and pass `permalinkSignInOptions()` so the
    // promise in the copy — that they land back HERE — actually holds.
    const handleSignIn = () => {
      track("login_button_clicked", { location: "route_error_refusal" });
      captureAppSignInReturnPath();
      signIn(permalinkSignInOptions());
    };

    return (
      <div
        className="flex items-center justify-center min-h-screen p-6"
        data-testid="route-signin-required-screen"
      >
        <div className="text-center max-w-md">
          <LogIn className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">{SIGN_IN_HEADING}</h2>
          <p className="text-sm text-muted-foreground mb-4">{SIGN_IN_BODY}</p>
          <div className="flex items-center justify-center gap-2">
            <Button onClick={handleSignIn}>Sign in</Button>
            <Button onClick={goHome} variant="ghost">
              Go home
            </Button>
          </div>
        </div>
      </div>
    );
  }

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
