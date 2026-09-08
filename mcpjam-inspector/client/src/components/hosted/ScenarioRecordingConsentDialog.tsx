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
 * The first thing a tester sees: this session is recorded, continue or leave.
 *
 * **Product-owned, and not optional (BB-176).** It replaces a creator-authored
 * "welcome" overlay that only appeared when someone had typed a body — so
 * whether a tester learned their session would be read depended on the
 * creator remembering to say it, buried in whatever else that copy covered.
 * Recording is the product's statement to make, so this dialog carries it and
 * nothing else.
 *
 * **No escape hatches.** No close button, and the backdrop and Escape do not
 * dismiss it — `AlertDialog` already ignores outside clicks, and Escape is
 * cancelled below. Continue IS the acceptance; Leave is the refusal. A notice
 * that can be flicked away without answering is not consent, and either
 * answer must be a thing the tester actually did.
 *
 * There is deliberately no acknowledgement checkbox. Continue is an explicit
 * act on a dialog that says one thing; a checkbox in front of it adds a step
 * without adding information. If legal asks for one, it goes here.
 */
export function ScenarioRecordingConsentDialog({
  open,
  hasTasks,
  onContinue,
  onLeave,
}: {
  open: boolean;
  /**
   * Whether this study has a "what to try" list. Only then does the dialog
   * point at the control — naming a header button that is not rendered would
   * send the tester looking for it.
   */
  hasTasks: boolean;
  onContinue: () => void;
  onLeave: () => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        // Escape is the one dismissal Radix leaves open on an AlertDialog.
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="sm:max-w-md"
        data-testid="scenario-recording-consent"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>This session will be recorded</AlertDialogTitle>
          <AlertDialogDescription>
            The team conducting the study will be able to read it later.
            {hasTasks ? " What to try is in the top right." : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onLeave}
            data-testid="scenario-recording-consent-leave"
          >
            Leave
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onContinue}
            data-testid="scenario-recording-consent-continue"
          >
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Where a tester lands after Leave.
 *
 * A terminal panel rather than a navigation, because there is usually nowhere
 * to navigate TO: a tester arrives by pasted link, so the tab has no history
 * to go back to and `window.close()` does nothing for a window the script did
 * not open. Both would leave them staring at a page whose dialog just
 * vanished, which reads as a bug rather than as a choice that took effect.
 *
 * Rejoining is offered because Leave is not a punishment — someone who clicked
 * it to read the notice again should not have to re-find the link.
 */
export function ScenarioRecordingDeclinedPanel({
  onRejoin,
}: {
  onRejoin: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      data-testid="scenario-recording-declined"
    >
      <div className="max-w-sm text-center">
        <h2 className="text-base font-semibold text-foreground">
          You left this session
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing was sent, so there is nothing for the team to read. You can
          close this tab, or rejoin if you changed your mind.
        </p>
        <button
          type="button"
          onClick={onRejoin}
          data-testid="scenario-recording-declined-rejoin"
          className="mt-4 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Rejoin this session
        </button>
      </div>
    </div>
  );
}
