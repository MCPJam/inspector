import { useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { AnnouncementDialog } from "@/components/announcement-popups";
import { LegalConsentNotice } from "@/components/legal/LegalConsentNotice";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { HOSTED_MODE } from "@/lib/config";
import { markPendingSignUpToast } from "@/lib/pending-signup-toast";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  getGuestVisit,
  markGuestDialogClosed,
  subscribeGuestVisit,
  touchGuestVisit,
  type GuestVisit,
} from "@/lib/returning-guest";

const COPY_VARIANT = "not_backed_up_v1";
const ACTIVITY_THROTTLE_MS = 60 * 1000;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "visibilitychange",
] as const;

function currentPage(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

function promptProps(visit: GuestVisit) {
  return {
    prompt: "dialog",
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

  // Real input, not a timer: a tab left open overnight starts the new day's
  // visit when the guest comes back to it.
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
      track("returning_guest_prompt_dismissed", promptProps(visit));
    }
    markGuestDialogClosed();
  };

  return (
    <AnnouncementDialog
      eligible={eligible}
      onDismiss={dismiss}
      onOpenAutoFocus={() => {
        if (visit) {
          track("returning_guest_prompt_shown", promptProps(visit));
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
            markGuestDialogClosed();
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
