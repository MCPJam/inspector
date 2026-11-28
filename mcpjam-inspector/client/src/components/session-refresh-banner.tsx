import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { Loader2 } from "lucide-react";
import { AppBanner } from "@mcpjam/design-system/app-banner";
import { Button } from "@mcpjam/design-system/button";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

/**
 * Shown when the Convex auth token could not be refreshed.
 *
 * Without this the failure is invisible until it isn't: Convex drops to
 * `noAuth`, every open query re-runs with no identity, and the page either
 * crashes into the generic error boundary — whose "Try again" re-throws
 * immediately, because Convex never re-attempts on its own — or silently
 * renders as logged out. Neither tells the user the truth, which is that we
 * briefly couldn't reach the auth server.
 *
 * Retry is a real in-place re-authentication (see `retryNonce`), not a
 * disguised page reload. The recovery boundary can reset temporary page state.
 */
export function SessionRefreshBanner({
  dismissible = true,
}: {
  dismissible?: boolean;
}) {
  const status = useSessionRefreshStore((s) => s.status);
  const kind = useSessionRefreshStore((s) => s.kind);
  const { signIn } = useInspectorAuth();

  if (status === "idle" || !kind) return null;

  const isRetrying = status === "retrying";
  const isSignedOut = kind === "signed_out";

  const handleSignIn = () => {
    // Remember where they were, so WorkOS returns them here rather than to
    // the app's front door.
    captureAppSignInReturnPath();
    void Promise.resolve(signIn(permalinkSignInOptions())).catch(() => {});
  };

  return (
    <AppBanner
      data-testid="session-refresh-banner"
      className="fixed inset-x-0 top-0 z-50 backdrop-blur"
      onDismiss={
        dismissible
          ? () => useSessionRefreshStore.getState().clear()
          : undefined
      }
      actions={
        <>
          {isSignedOut ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={isRetrying}
              onClick={() => useSessionRefreshStore.getState().retry()}
            >
              {isRetrying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Retrying…
                </>
              ) : (
                "Retry"
              )}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleSignIn}>
            Sign in
          </Button>
        </>
      }
    >
      {isSignedOut
        ? "Your session has expired."
        : "Couldn't refresh your session."}
    </AppBanner>
  );
}
