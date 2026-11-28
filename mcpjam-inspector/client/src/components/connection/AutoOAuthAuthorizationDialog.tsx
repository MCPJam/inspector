import { useRef, type MouseEvent } from "react";
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
import { useAutoOAuthAuthorizationStore } from "@/lib/oauth/auto-oauth-escalation";

export function AutoOAuthAuthorizationDialog() {
  const prompt = useAutoOAuthAuthorizationStore((state) => state.queue[0]);
  const markShown = useAutoOAuthAuthorizationStore((state) => state.markShown);
  const settle = useAutoOAuthAuthorizationStore((state) => state.settle);
  const returnFocus = useRef<HTMLElement | null>(null);
  if (!prompt) return null;

  const decide = (
    event: MouseEvent<HTMLButtonElement>,
    decision: "continue" | "not_now",
  ) => {
    // A double-click must not settle the next server in the queue.
    if (event.detail > 1) {
      event.preventDefault();
      return;
    }
    settle(prompt.id, decision);
  };

  return (
    <AlertDialog
      key={prompt.id}
      open
      onOpenChange={(open) => {
        if (!open) settle(prompt.id, "dismiss");
      }}
    >
      <AlertDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement;
          if (!returnFocus.current && activeElement instanceof HTMLElement) {
            returnFocus.current = activeElement;
          }
          markShown(prompt.id);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (useAutoOAuthAuthorizationStore.getState().queue.length > 0) return;
          const target = returnFocus.current;
          returnFocus.current = null;
          if (target?.isConnected) target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Authorize "{prompt.serverName}"?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This server requires sign-in before Inspector can connect.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={(event) => decide(event, "not_now")}>
            Not now
          </AlertDialogCancel>
          <AlertDialogAction onClick={(event) => decide(event, "continue")}>
            Continue to sign in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
