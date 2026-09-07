import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { LocalHarnessControllerState } from "@/hooks/useLocalHarnessTarget";

/**
 * What the composer says about local setup, in the composer's own notice slot.
 *
 * ── Why the composer and not a toast ─────────────────────────────────────
 * Setup takes minutes, and the thing the user is waiting to do is type and
 * press Send. A toast is gone before the download is; a modal blocks the very
 * draft the flow is arranged to preserve. So the status lives where the next
 * action is.
 *
 * ── The one thing this must not do ───────────────────────────────────────
 * Overwrite another gate's message. `ChatInput` has ONE `notice` slot and the
 * as-run conversation-target disclosure already uses it — and that one is not
 * decoration: it is the only place the button that re-enables Send lives.
 * Replacing it would disable the visible Send and hide the control that
 * re-enables it. So this composes BELOW it and never in place of it.
 */
export function LocalHarnessComposerNotice({
  controller,
  onRetry,
}: {
  controller: LocalHarnessControllerState;
  /**
   * Explicit Retry.
   *
   * It reopens the dialog rather than silently re-POSTing: a retry may reuse a
   * still-matching in-memory approval, but a reload or a changed context needs
   * a fresh one — and the dialog is the only thing that can tell the user
   * which case they are in.
   */
  onRetry: () => void;
}) {
  const { phase, runtimeStatus, statusFetchFailed } = controller;

  if (phase === "installing") {
    const percent =
      runtimeStatus?.state === "downloading" ? runtimeStatus.percent : undefined;
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        data-testid="local-harness-composer-notice"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        <span>
          {percent === undefined
            ? "Verifying…"
            : `Setting up Claude Code · ${percent}%`}
        </span>
        {/* A failed status READ is not a failed install: the download is very
            likely still going, and telling the user it failed sends them to
            retry something that is running. */}
        {statusFetchFailed ? (
          <span className="text-muted-foreground/70">
            (couldn&apos;t read progress just now)
          </span>
        ) : null}
      </div>
    );
  }

  if (phase === "authorizing") {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        data-testid="local-harness-composer-notice"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Authorizing Claude Code on this machine…
      </div>
    );
  }

  if (phase === "failed" || phase === "interrupted") {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        data-testid="local-harness-composer-notice"
        role="alert"
      >
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {phase === "interrupted"
            ? "Setup was interrupted. Retry to continue."
            : (controller.reason ?? "Claude Code setup didn't finish.")}
        </span>
        {/* Explicit, always. Nothing retries a 200 MB download on a poll, a
            reload or a remount. */}
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (phase === "unavailable") {
    // Only reachable when the user explicitly asked for local — the caller
    // renders nothing otherwise. Send is disabled in this state, so the
    // explanation has to be here or the disabling is unexplained.
    return (
      <div
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        data-testid="local-harness-composer-notice"
      >
        {controller.reason ??
          "This Inspector can't run Claude Code on this machine."}
      </div>
    );
  }

  if (phase === "needs-signin") {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        data-testid="local-harness-composer-notice"
      >
        <span>
          {controller.reason ??
            "Sign in to run Claude Code on this machine."}
        </span>
      </div>
    );
  }

  return null;
}

/**
 * The one-line "setup finished, press Send" state.
 *
 * Separate from the notice above because it is not a status — it is an
 * instruction, and it only makes sense right after a COLD install the user
 * kicked off from this composer. A queued send would have been the other
 * choice, and is deliberately not what happens: a prompt that fires itself
 * minutes later, after a download, is not what anybody pressed.
 */
export function LocalHarnessReadyNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-foreground"
      data-testid="local-harness-ready-notice"
      role="status"
      aria-live="polite"
    >
      <span>Ready — press Send to continue.</span>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
