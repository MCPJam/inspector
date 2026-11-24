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
  const settle = useAutoOAuthAuthorizationStore((state) => state.settle);
  if (!prompt) return null;

  return (
    <AlertDialog
      key={prompt.id}
      open
      onOpenChange={(open) => {
        if (!open) settle(prompt.id, false);
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Authorize "{prompt.serverName}"?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This server requires sign-in before Inspector can connect.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // A double-click must not confirm the next server in the queue.
              if (event.detail > 1) {
                event.preventDefault();
                return;
              }
              settle(prompt.id, true);
            }}
          >
            Continue to sign in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
