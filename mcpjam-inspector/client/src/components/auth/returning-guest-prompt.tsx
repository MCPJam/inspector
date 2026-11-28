import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { AnnouncementDialog } from "@/components/announcement-popups";
import { LegalConsentNotice } from "@/components/legal/LegalConsentNotice";
import { severityStyles } from "@/components/ui/error-card";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { HOSTED_MODE } from "@/lib/config";
import { markPendingSignUpToast } from "@/lib/pending-signup-toast";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  getGuestVisit,
  markGuestVisit,
  subscribeGuestVisit,
  touchGuestVisit,
  type GuestVisit,
} from "@/lib/returning-guest";
import { cn } from "@/lib/utils";

const COPY_VARIANT = "not_backed_up_v1";
const ACTIVITY_THROTTLE_MS = 60 * 1000;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "visibilitychange",
] as const;

type Prompt = "dialog" | "notice";

function currentPage(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

function promptProps(prompt: Prompt, visit: GuestVisit) {
  return {
    prompt,
    copy_variant: COPY_VARIANT,
    page: currentPage(),
    visit_number: visit.visitNumber,
  };
}

/** The current visit for a hosted guest, or null for anyone else. */
function useReturningGuestVisit(): GuestVisit | null {
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const { isLoading: isConvexLoading } = useConvexAuth();
  const isGuest = HOSTED_MODE && !user && !isWorkOsLoading && !isConvexLoading;
  const visit = useSyncExternalStore(subscribeGuestVisit, getGuestVisit);

  // Only real input counts as activity: a tab left open and visible while the
  // guest is away must still start a new visit when they come back.
  useEffect(() => {
    if (!isGuest) return;
    let lastTouchAt = 0;
    const touch = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastTouchAt < ACTIVITY_THROTTLE_MS) return;
      lastTouchAt = now;
      touchGuestVisit(now);
    };
    touch();
    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, touch, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, touch);
      }
    };
  }, [isGuest]);

  return isGuest ? visit : null;
}

function useStartSignUp() {
  const { signUp } = useInspectorAuth();
  return (location: string) => {
    track("sign_up_button_clicked", { location, page: currentPage() });
    // Both writes must land before signUp() navigates away.
    markPendingSignUpToast();
    captureAppSignInReturnPath();
    signUp(permalinkSignInOptions());
  };
}

/** Asks a returning guest to sign up, once per visit, through the queue. */
export function ReturningGuestDialog({ enabled }: { enabled: boolean }) {
  const visit = useReturningGuestVisit();
  const startSignUp = useStartSignUp();
  const eligible = enabled && !!visit?.isReturning && !visit.dialogClosed;

  const dismiss = () => {
    if (visit) {
      track("returning_guest_prompt_dismissed", promptProps("dialog", visit));
    }
    markGuestVisit("dialogClosedForVisit");
  };

  return (
    <AnnouncementDialog
      eligible={eligible}
      onDismiss={dismiss}
      onOpenAutoFocus={() => {
        if (visit) {
          track("returning_guest_prompt_shown", promptProps("dialog", visit));
        }
      }}
      className="sm:max-w-md"
      data-testid="returning-guest-dialog"
    >
      <DialogHeader>
        <DialogTitle>Welcome back</DialogTitle>
        <DialogDescription className="text-pretty">
          Guest work isn’t backed up. Create a free account to keep your servers
          and chats, and run evals against them.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
        <Button
          className="flex-1"
          onClick={() => {
            markGuestVisit("dialogClosedForVisit");
            startSignUp("returning_guest_dialog");
          }}
        >
          Create account
        </Button>
        <Button variant="outline" className="flex-1" onClick={dismiss}>
          Not now
        </Button>
      </div>
      <LegalConsentNotice />
    </AnnouncementDialog>
  );
}

/** Inline reminder for a returning guest; dismissed for the rest of the visit. */
export function ReturningGuestNotice() {
  const visit = useReturningGuestVisit();
  const startSignUp = useStartSignUp();
  const visible = !!visit?.isReturning && !visit.noticeDismissed;
  const impressionForVisit = useRef<number | null>(null);

  useEffect(() => {
    if (!visible || !visit) return;
    if (impressionForVisit.current === visit.visitStartedAt) return;
    impressionForVisit.current = visit.visitStartedAt;
    track("returning_guest_prompt_shown", promptProps("notice", visit));
  }, [visible, visit]);

  if (!visible || !visit) return null;

  const styles = severityStyles("info");
  const Icon = styles.icon;
  return (
    <div
      className={cn("rounded-md border p-3 text-xs", styles.container)}
      data-testid="returning-guest-notice"
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 flex-shrink-0 self-start",
            styles.iconClass,
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium leading-tight">
            You’re using MCPJam as a guest
          </p>
          <p className="leading-snug text-foreground/80">
            Guest work isn’t backed up. Create a free account to keep your
            servers and chats.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={styles.action}
          onClick={() => startSignUp("returning_guest_notice")}
        >
          Create account
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-foreground/70"
          aria-label="Dismiss"
          onClick={() => {
            track(
              "returning_guest_prompt_dismissed",
              promptProps("notice", visit),
            );
            markGuestVisit("noticeDismissedForVisit");
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
