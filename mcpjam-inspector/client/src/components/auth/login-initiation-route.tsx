import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import { useAppNavigate, useCurrentSearchParam } from "@/lib/app-navigation";

/**
 * `/login` — the WorkOS **Initiate Login URL**, and the fix for IdP-initiated SSO.
 *
 * Clicking the MCPJam tile in an Okta dashboard starts the flow at the IdP, not
 * here: Okta posts its SAML assertion to WorkOS, WorkOS validates it, and then
 * the browser lands on `/callback` with an authorization code. That exchange
 * fails by construction. It runs CLIENT-SIDE in `@workos-inc/authkit-js`, and it
 * needs the PKCE code verifier that sign-in wrote into THIS tab's
 * `sessionStorage` (`workos:code-verifier`) — a key that only exists when the
 * sign-in started in the app. A login that started at Okta has no such tab, so
 * authkit refuses with "Couldn't exchange code… The developer may not have
 * configured a Login Initiation endpoint."
 *
 * The sanctioned fix is this route. With an Initiate Login URL configured
 * (Applications → Redirects, per WorkOS environment), AuthKit recognizes a
 * non-app-originated login and redirects the browser HERE instead of issuing a
 * code. We then start an ordinary, app-originated sign-in: authkit-js mints its
 * own verifier, AuthKit completes it silently against the SSO session Okta
 * already established (no second prompt), and the code lands on `/callback`
 * with a verifier that matches.
 *
 * It has to be a client route for the same reason: a server-side 302 to
 * `/user_management/authorize` cannot write a verifier into the browser's
 * sessionStorage. The SPA must boot and call `signIn()` itself.
 *
 * `organization_id` selects the organization's SSO connection without relying
 * on email-domain discovery. Forward only this routing hint through AuthKit's
 * signIn API so the SDK still owns PKCE and the callback. WorkOS enforces access
 * to the selected organization; the hint does not grant membership. Other query
 * parameters, including the deprecated `context` hand-off, stay ignored.
 */
export function LoginInitiationRoute() {
  const {
    user,
    organizationId: currentOrganizationId,
    isLoading,
    signIn,
  } = useAuth();
  const navigate = useAppNavigate();
  const requestedOrganizationId = useCurrentSearchParam("organization_id");
  const organizationId =
    requestedOrganizationId &&
    /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(requestedOrganizationId)
      ? requestedOrganizationId
      : undefined;
  // StrictMode double-invokes effects in dev, and `signIn()` is a full-page
  // navigation — firing it twice races two authorize requests (and two
  // verifiers) against one another.
  const startedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  const startSignIn = useCallback(() => {
    setFailed(false);
    // A rejection here means the browser is NOT leaving this page, so the
    // spinner below would sit there forever. This is the whole entry point for
    // an SSO user arriving from their dashboard: a dead end costs them the
    // login with nothing to click. `/callback` guards the same hazard with its
    // own recovery UI (see `callbackRecoveryExpired` in App.tsx).
    // `try`/`catch` as well as `.catch`, because a throw before the promise is
    // returned is not a rejected promise.
    try {
      void Promise.resolve(
        organizationId ? signIn({ organizationId }) : signIn(),
      ).catch(() => setFailed(true));
    } catch {
      setFailed(true);
    }
  }, [signIn, organizationId]);

  useEffect(() => {
    if (isLoading || startedRef.current) return;
    startedRef.current = true;
    // An existing session in another organization must still use the requested
    // SSO connection. Reopening a link for the current organization is a no-op.
    if (user && (!organizationId || organizationId === currentOrganizationId)) {
      navigate("/", { replace: true });
      return;
    }
    startSignIn();
  }, [
    isLoading,
    user,
    organizationId,
    currentOrganizationId,
    startSignIn,
    navigate,
  ]);

  if (failed) {
    return (
      <div
        // The failure replaces the spinner in place, with no navigation to
        // announce it — without a live region a screen reader user is left on
        // "Signing you in…" and never learns there is a retry to press.
        role="alert"
        className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
        data-testid="login-initiation-error"
      >
        <span className="max-w-md">
          Couldn&apos;t start sign-in. Try again, or return to your identity
          provider and reopen MCPJam.
        </span>
        <Button size="sm" onClick={startSignIn}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      data-testid="login-initiation"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-primary" />
      <span>Signing you in…</span>
    </div>
  );
}
