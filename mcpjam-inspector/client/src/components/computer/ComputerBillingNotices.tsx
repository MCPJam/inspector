import { useCallback, useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { AlertTriangle, PauseCircle, X } from "lucide-react";
import { useAppNavigate } from "@/lib/app-navigation";
import { useComputerUsage } from "@/hooks/useProjectComputer";

/**
 * COMP-7 billing-pause messaging, shared by the full-page Computer panel
 * (`ComputerView`) and the Playground Shell drawer (`ComputerTerminalPane`) so
 * the copy can't drift between surfaces.
 */

// Shared with COMP-12's data-durability copy: pausing preserves the
// filesystem — say it the same way everywhere.
export const PAUSE_PRESERVE_COPY =
  "Files are preserved when your computer pauses.";

export function useNavigateToBilling(): () => void {
  const navigate = useAppNavigate();
  // `/billing` is the app's billing entry path — App resolves it to the active
  // org's billing page (reused from the limit-dialog top-up flow).
  return useCallback(() => navigate("/billing"), [navigate]);
}

/**
 * Warns, before the pause happens, when the org has burned >= 80% of a finite
 * compute allowance and the wallet can't absorb the overage. Dismissible but
 * re-appearing — a dismissal is scoped to the current billing window (org's
 * UTC month via `windowStartAt`), so it comes back when the allowance resets.
 * Renders nothing when the backend doesn't signal a warning (older backends
 * omit the field ⇒ falsy ⇒ no banner).
 */
export function ComputerBillingWarningBanner({
  projectId,
}: {
  projectId: string;
}) {
  const usage = useComputerUsage(projectId);
  const navigateToBilling = useNavigateToBilling();
  const windowStartAt = usage?.windowStartAt ?? 0;
  const storageKey = `computer-billing-warning-dismissed:${projectId}:${windowStartAt}`;
  const [dismissed, setDismissed] = useState(false);

  // Re-read dismissal whenever the billing window changes so a new month (new
  // key, no stored dismissal) shows the banner again.
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(storageKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  if (!usage || !usage.billingPauseWarning || dismissed) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / quota — dismissal just won't persist across the window.
    }
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      data-testid="computer-billing-warning"
      className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium text-foreground">
          You've used 80% of your included compute hours. Your computer will
          pause when they run out.
        </p>
        <p className="text-muted-foreground">
          {PAUSE_PRESERVE_COPY} Add credits or wait until next month's reset to
          keep going.
        </p>
        <div>
          <Button size="sm" variant="outline" onClick={navigateToBilling}>
            Add credits
          </Button>
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="ml-auto h-6 w-6 shrink-0"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * The post-hibernate state when a machine was paused FOR BILLING (as opposed to
 * idle). States why and the remedy instead of a wake button that would just
 * bounce back to sleep.
 */
export function ComputerPausedForBillingNotice() {
  const navigateToBilling = useNavigateToBilling();
  return (
    <div
      role="status"
      data-testid="computer-paused-for-billing"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
    >
      <PauseCircle className="h-6 w-6 text-muted-foreground" />
      <div className="flex max-w-md flex-col gap-1.5">
        <p className="font-medium text-foreground">Paused for billing</p>
        <p className="text-muted-foreground">
          Your computer paused because your included compute hours ran out and
          there aren't enough credits to cover more. {PAUSE_PRESERVE_COPY} Add
          credits or wait until next month's reset to resume.
        </p>
      </div>
      <Button size="sm" onClick={navigateToBilling}>
        Add credits
      </Button>
    </div>
  );
}
