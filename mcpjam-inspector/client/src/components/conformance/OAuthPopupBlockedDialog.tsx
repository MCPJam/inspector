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

/**
 * Shown when the browser blocked the OAuth suite's sign-in window.
 *
 * The suite opens that window once the run has an authorization URL, which is
 * after the Run click, so browsers treat it as an unrequested popup. The
 * inline note at the bottom of the OAuth section sits below the fold, and the
 * run just waits there. This asks up front instead: "Open sign-in page" is a
 * real click, so the window it opens is allowed.
 *
 * No escape hatch: `AlertDialog` ignores outside clicks and Escape is
 * cancelled below. Closing without an answer would leave the suite waiting
 * with nothing on screen saying why. It closes when the window opens or the
 * suite is skipped, both driven by the run's own state.
 */
export function OAuthPopupBlockedDialog({
  open,
  serverName,
  onOpen,
  onSkip,
}: {
  open: boolean;
  serverName: string;
  onOpen: () => void;
  onSkip: () => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="sm:max-w-md"
        data-testid="oauth-popup-blocked-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Your browser blocked the sign-in window</AlertDialogTitle>
          <AlertDialogDescription>
            OAuth checks need you to sign in to {serverName}. The other checks
            keep running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onSkip}>Skip OAuth</AlertDialogCancel>
          <AlertDialogAction onClick={onOpen}>Open sign-in page</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
