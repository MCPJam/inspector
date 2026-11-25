import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  consumePendingSignUpToast,
  markPendingSignUpToast,
} from "@/lib/pending-signup-toast";
import {
  SidebarPromptCard,
  sidebarPromptPage,
  useSidebarPromptShown,
} from "./sidebar-prompt-card";

/**
 * One click to WorkOS sign-up, back to the same page. No nudge dialog: the
 * card already says what an account gets them.
 */
export function SidebarGuestSignUpPrompt() {
  const { signUp } = useInspectorAuth();
  useSidebarPromptShown("guest_signup", null);

  return (
    <SidebarPromptCard
      kind="guest_signup"
      onClick={() => {
        track("sign_up_button_clicked", {
          location: "sidebar_prompt",
          page: sidebarPromptPage(),
        });
        // Both writes must land before signUp() navigates away.
        markPendingSignUpToast();
        captureAppSignInReturnPath();
        signUp(permalinkSignInOptions());
      }}
    />
  );
}

/** WorkOS and browser clocks disagree by a little. */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Confirms the account once the guest lands back signed in. Someone who took
 * the sign-in link on the WorkOS page already had an account, so the toast
 * only shows for a user created after the card was clicked. Mounted app-wide
 * because the mobile sidebar sheet starts closed.
 */
export function AccountCreatedToast() {
  useAccountCreatedToast();
  return null;
}

function useAccountCreatedToast() {
  const { user } = useAuth();
  const userCreatedAt = user?.createdAt ?? null;
  useEffect(() => {
    if (!userCreatedAt) return;
    const clickedAt = consumePendingSignUpToast();
    if (clickedAt === null) return;
    const createdAt = Date.parse(userCreatedAt);
    if (Number.isNaN(createdAt) || createdAt < clickedAt - CLOCK_SKEW_MS) {
      return;
    }
    toast.success("Account created", {
      description: "You get 200 free credits a day.",
    });
  }, [userCreatedAt]);
}
