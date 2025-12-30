import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const SKIP_CHAT_RESET_CONFIRMATION_KEY = "skipChatResetConfirmation";

interface ConfirmChatResetDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message?: string;
}

export function ConfirmChatResetDialog({
  open,
  onConfirm,
  onCancel,
  message = "Resetting the chat will clear your current conversation thread. This action cannot be undone.",
}: ConfirmChatResetDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (open) {
      const shouldSkip =
        localStorage.getItem(SKIP_CHAT_RESET_CONFIRMATION_KEY) === "true";
      if (shouldSkip) {
        onConfirm();
      }
    }
  }, [open, onConfirm]);

  const handleConfirm = () => {
    if (dontShowAgain) {
      localStorage.setItem(SKIP_CHAT_RESET_CONFIRMATION_KEY, "true");
    }
    onConfirm();
  };

  const shouldSkip =
    localStorage.getItem(SKIP_CHAT_RESET_CONFIRMATION_KEY) === "true";
  if (shouldSkip) {
    return null;
  }

  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset chat?</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row items-center sm:justify-between">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="dont-show-again"
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
            />
            <Label
              htmlFor="dont-show-again"
              className="text-sm text-muted-foreground cursor-pointer"
            >
              Don't show this again
            </Label>
          </div>
          <div className="flex gap-2">
            <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>
              Reset chat
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
