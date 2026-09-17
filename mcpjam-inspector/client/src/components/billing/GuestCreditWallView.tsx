import { JamIllustration } from "./JamIllustration";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

export function GuestCreditWallView({
  isTreatment,
  onDismiss,
  onCreateAccount,
  onSeePlans,
  onSignIn,
  modal = true,
}: {
  isTreatment: boolean;
  onDismiss: () => void;
  onCreateAccount: () => void;
  onSeePlans: () => void;
  onSignIn: () => void;
  modal?: boolean;
}) {
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />

        {isTreatment ? (
          <>
            <DialogHeader>
              <DialogTitle>There's so much more to jam on.</DialogTitle>
              <DialogDescription>
                You're out of guest credits. Create a free account to test
                frontier models in Playground, and try Swarm, User Testing,
                Evals with 500 free eval iterations!
              </DialogDescription>
            </DialogHeader>
            {/* Primary is first in the DOM so Radix's focus scope lands on it —
                Enter converts instead of opening pricing — and flex-row-reverse
                restores the Figma order with the primary on the right. On a
                narrow modal the buttons stack instead of cramping. */}
            <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
              <Button onClick={onCreateAccount} className="flex-1">
                Create free account
              </Button>
              <Button variant="outline" onClick={onSeePlans} className="flex-1">
                See paid plans
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>You've used up your free guest credits.</DialogTitle>
              <DialogDescription>
                Sign in to get{" "}
                <strong className="text-foreground font-medium">10×</strong> the
                free credits. + 500 free eval iterations!
              </DialogDescription>
            </DialogHeader>
            <Button onClick={onSignIn} className="w-full">
              Sign in
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
