/**
 * Stop a navigation that would throw away unsaved settings.
 *
 * TWO MECHANISMS, because there are two ways to leave and neither covers the
 * other. React Router's `useBlocker` catches in-app navigation and can show a
 * real prompt; `beforeunload` catches a closed tab or a typed URL and can only
 * show the browser's own generic one. Using either alone leaves a whole class
 * of exits silent, which is the failure this guard exists to prevent: a person
 * clicks a run in the sidebar and their four edits are gone with no warning.
 *
 * Deliberately NOT wired into `navigateApp`: a guard that lives in one
 * navigation helper is a guard that misses every other caller, and the router
 * is the one place all of them meet.
 */

import { useCallback, useEffect } from "react";
import { useBlocker } from "react-router";

export function useUnsavedChangesGuard(
  hasUnsavedChanges: boolean,
  /**
   * Called when the person confirms they are leaving.
   *
   * REQUIRED in spirit even though it is optional in the type: whoever owns
   * the draft has to throw it away here. This hook only pauses a navigation —
   * it has no idea what "unsaved" refers to — so a caller that does not
   * discard leaves state the person was just told they were abandoning, and
   * the prompt becomes a lie the second time it appears.
   */
  onDiscard?: () => void,
  message = "You have unsaved settings. Leave without saving?"
) {
  // Stable across renders that do not change the answer: react-router
  // re-registers the blocker whenever this function's identity moves, and this
  // component re-renders on every keystroke and every run-progress tick.
  const shouldBlock = useCallback(
    ({
      currentLocation,
      nextLocation,
    }: {
      currentLocation: { pathname: string };
      nextLocation: { pathname: string };
    }) =>
      hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname,
    [hasUnsavedChanges],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // `confirm` rather than a styled dialog on purpose: this fires DURING a
    // navigation the router has already paused, and a component-rendered
    // dialog would have to survive a route that is mid-transition.
    if (window.confirm(message)) {
      onDiscard?.();
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker, message, onDiscard]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (event: BeforeUnloadEvent) => {
      // The browser shows its own copy; assigning `returnValue` is the only
      // part still honoured, and the string is ignored everywhere modern.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  return blocker.state === "blocked";
}
