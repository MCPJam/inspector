import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useAuth } from "@workos-inc/authkit-react";
import { useEffect } from "react";
import { useGuestLimitDialogStore } from "@/stores/guest-limit-dialog-store";

export function GuestLimitDialog() {
  const isOpen = useGuestLimitDialogStore((s) => s.isOpen);
  const close = useGuestLimitDialogStore((s) => s.close);
  const setAuthStatus = useGuestLimitDialogStore((s) => s.setAuthStatus);
  const { user, isLoading, signIn } = useAuth();

  useEffect(() => {
    setAuthStatus(isLoading ? "loading" : user ? "signedIn" : "guest");
  }, [isLoading, setAuthStatus, user]);

  if (isLoading || user) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>You've used today's free guest limit</DialogTitle>
          <DialogDescription>
            Sign in to get{" "}
            <strong className="text-foreground font-medium">6× more</strong>{" "}
            daily usage.
          </DialogDescription>
        </DialogHeader>
        <Button onClick={() => signIn()} className="w-full">
          Sign in
        </Button>
      </DialogContent>
    </Dialog>
  );
}
