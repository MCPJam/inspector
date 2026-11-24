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
  PENDING_SIGNUP_TOAST_TTL_MS,
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

/**
 * Confirms the account once the guest lands back signed in. Someone who took
 * the sign-in link on the WorkOS page already had an account, so the toast
 * only shows for a user created within the marker's lifetime.
 */
export function useAccountCreatedToast() {
  const { user } = useAuth();
  const userCreatedAt = user?.createdAt ?? null;
  useEffect(() => {
    if (!userCreatedAt) return;
    if (!consumePendingSignUpToast()) return;
    const createdAt = Date.parse(userCreatedAt);
    if (Number.isNaN(createdAt)) return;
    if (Date.now() - createdAt > PENDING_SIGNUP_TOAST_TTL_MS) return;
    toast.success("Account created", {
      description: "You get 200 free credits a day.",
    });
  }, [userCreatedAt]);
}
