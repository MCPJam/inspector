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

import { useEffect } from "react";
import { useBlocker } from "react-router";

export function useUnsavedChangesGuard(
  hasUnsavedChanges: boolean,
  message = "You have unsaved settings. Leave without saving?"
) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedChanges &&
      currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // `confirm` rather than a styled dialog on purpose: this fires DURING a
    // navigation the router has already paused, and a component-rendered
    // dialog would have to survive a route that is mid-transition.
    if (window.confirm(message)) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker, message]);

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
