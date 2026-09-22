import { useAuth } from "@workos-inc/authkit-react";
import { CircleAlert, Loader2, X } from "lucide-react";
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
 * disguised page reload, so the user keeps their page state.
 */
export function SessionRefreshBanner() {
  const status = useSessionRefreshStore((s) => s.status);
  const kind = useSessionRefreshStore((s) => s.kind);
  const { signIn } = useAuth();

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
    <div
      role="alert"
      data-testid="session-refresh-banner"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm backdrop-blur"
    >
      <CircleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="text-foreground">
        {isSignedOut
          ? "Your session has expired."
          : "Couldn't refresh your session."}
      </span>

      {isSignedOut ? (
        <Button size="sm" variant="outline" onClick={handleSignIn}>
          Sign in
        </Button>
      ) : (
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

      <button
        type="button"
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => useSessionRefreshStore.getState().clear()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
