import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";

interface XAADcrReRegisterControlProps {
  disabled?: boolean;
  onRegisterAnotherClient: () => void;
}

/**
 * DCR-only mid-run recovery: force a fresh dynamic registration at the target
 * authorization server. This is the ONLY action that clears the duplicate-risk
 * gate, so a user who acknowledges "a second remote client may be created" can
 * re-register after a reload wiped this session's DCR credentials.
 *
 * The registration strategy itself is chosen in the "Configure Server to Test"
 * modal; only this recovery action lives on the flow surface.
 */
export function XAADcrReRegisterControl({
  disabled,
  onRegisterAnotherClient,
}: XAADcrReRegisterControlProps) {
  const [confirmReregister, setConfirmReregister] = useState(false);

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          This session already registered a client at the authorization server.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 text-xs text-muted-foreground"
          disabled={disabled}
          onClick={() => setConfirmReregister(true)}
        >
          Register another client
        </Button>
      </div>

      <AlertDialog open={confirmReregister} onOpenChange={setConfirmReregister}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Register another client?</AlertDialogTitle>
            <AlertDialogDescription>
              This performs a new registration at the authorization server. A
              second remote client may be created there — registrations are not
              automatically deleted. This session&apos;s cached credentials are
              discarded and the flow resets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current registration</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onRegisterAnotherClient();
                setConfirmReregister(false);
              }}
            >
              Register another client
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
