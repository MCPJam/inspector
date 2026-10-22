import type { ComponentProps } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";

/**
 * The one honest empty state for a guest who reaches a surface that only a
 * signed-in account can use — the personal cloud computer and the Claude Code
 * harness that runs inside it.
 *
 * A guest actor's server-resolved runtime config OMITS `harness`/`computer`
 * (the backend gates them behind account-scoped PHASE3 flags — see
 * `mcpjam-backend convex/lib/executionAccess.ts` and this inspector's
 * `server/utils/host-runtime-config.ts`). Without this affordance the guest
 * either sees the control silently missing or hits an opaque runtime error.
 * Instead we name the situation and offer the exact next step — WorkOS
 * sign-in — wired to the same `useInspectorAuth().signIn` flow the header uses.
 *
 * Surface-agnostic: pass a `message` naming what THIS surface gates. Mirrors
 * {@link ComputersUnavailableMessage}'s tone (state the fact, don't blame the
 * user), but this is an AUTH state — sign-in fixes it — not the data-plane /
 * operator state that component covers.
 */
export function GuestSignInMessage({
  message = "Sign in to use this — it's off for guests.",
  location,
  compact = false,
}: {
  /** Honest one-liner naming what's gated. Defaults to the harness copy. */
  message?: string;
  /** PostHog `login_button_clicked` location tag for this surface. */
  location?: string;
  /** Inline (in-tab) layout instead of a full-height centered pane. */
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-col items-start gap-3 rounded-md border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground"
          : "flex h-full flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground"
      }
    >
      <span className={compact ? "max-w-md" : "max-w-md text-center"}>
        {message}
      </span>
      <GuestSignInButton location={location} size="sm" />
    </div>
  );
}

export function GuestSignInButton({
  location,
  size,
  className,
}: {
  location?: string;
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { signIn } = useInspectorAuth();

  const handleSignIn = () => {
    // track() adds standard event props; the ratchet forbids raw PostHog calls.
    track("login_button_clicked", {
      location: location ?? "guest_signin_message",
    });
    captureAppSignInReturnPath();
    signIn(permalinkSignInOptions());
  };

  return (
    <Button
      type="button"
      size={size}
      className={className}
      onClick={handleSignIn}
    >
      Sign in
    </Button>
  );
}
