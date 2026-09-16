import { useCallback, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { track } from "@/lib/analytics";

/** Only the structured backend gate is actionable as signup. */
function isGuestSharingSignInRequired(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  return (
    !!data &&
    typeof data === "object" &&
    "code" in data &&
    data.code === "guest_sharing_requires_sign_in"
  );
}

function GuestSharingSignUpDialog({ onClose }: { onClose: () => void }) {
  const { signIn, signUp } = useAuth();
  const authenticate = (signup: boolean) => {
    track(signup ? "sign_up_button_clicked" : "login_button_clicked", {
      location: "guest_sharing_signup",
    });
    captureAppSignInReturnPath();
    // Keep the guest session and activation marker intact. On return,
    // useEnsureDbUser exchanges the cookie for a promotion proof and promotes
    // the existing guest's data before retiring the guest session.
    const options = permalinkSignInOptions();
    if (signup) void signUp(options);
    else void signIn(options);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign up to share</DialogTitle>
          <DialogDescription>
            Create an account to share this scenario. Your scenarios and history
            stay with you. After signing in, try sharing again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="outline" onClick={() => authenticate(false)}>
            Sign in
          </Button>
          <Button onClick={() => authenticate(true)}>Sign up to share</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Handle at the mutation's catch boundary, without changing its saved state. */
export function useGuestSharingSignUp() {
  const [open, setOpen] = useState(false);
  const handleGuestSharingError = useCallback((error: unknown): boolean => {
    if (!isGuestSharingSignInRequired(error)) return false;
    setOpen(true);
    return true;
  }, []);

  return {
    handleGuestSharingError,
    guestSharingPrompt: open ? (
      <GuestSharingSignUpDialog onClose={() => setOpen(false)} />
    ) : null,
  };
}
