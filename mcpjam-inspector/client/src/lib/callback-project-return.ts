import { useLayoutEffect } from "react";
import { navigateApp, routePaths } from "./app-navigation";
import { projectTransitionRecovery } from "./auth/project-transition-recovery";
import { consumeAppSignInReturnPath } from "./app-signin-return-path";
import {
  readPersistedCheckoutIntent,
  readBillingSignInReturnPath,
  clearBillingSignInReturnPath,
} from "./billing-deep-link";
import {
  readScenarioSignInReturnPath,
  clearScenarioSignInReturnPath,
} from "./scenario-session";
import {
  readCliSignInReturnPath,
  clearCliSignInReturnPath,
} from "./cli-signin-return-path";
import {
  readApiKeysSignInReturnPath,
  clearApiKeysSignInReturnPath,
} from "./api-keys-signin-return-path";
import {
  trackSignInReturnRestored,
  trackStaleProjectReturnRecovered,
} from "./project-route-telemetry";
import {
  createProjectSignInReturnRecoveryIntent,
  resolveProjectSignInReturnRecovery,
  type ProjectSignInReturnRecoveryIntent,
} from "./project-route-recovery";

/** Consume callback returns once, preserving special-flow precedence. */
export function consumeCallbackProjectReturn() {
  const scenarioReturnPath = readScenarioSignInReturnPath();
  const persistedCheckoutIntent = readPersistedCheckoutIntent();
  const billingReturnPath = persistedCheckoutIntent
    ? readBillingSignInReturnPath()
    : null;
  const cliReturnPath = readCliSignInReturnPath();
  const apiKeysReturnPath = readApiKeysSignInReturnPath();
  // Consumed (read AND cleared) whether or not it wins: a path left in
  // storage would outlive this sign-in and hijack the next one.
  const transition = projectTransitionRecovery.store.getState().marker;
  const appReturnPath =
    consumeAppSignInReturnPath() ??
    (transition && projectTransitionRecovery.isValid(transition)
      ? transition.path
      : null);
  clearScenarioSignInReturnPath();
  clearBillingSignInReturnPath();
  clearCliSignInReturnPath();
  clearApiKeysSignInReturnPath();
  // LAST in precedence, deliberately. The scenario, billing, CLI and
  // API-key flows encode an intent, not just a location, and each has its
  // own documented ordering; the generic path only says "put me back", so
  // it fills in for the ordinary case those four do not cover.
  const restoredPath =
    scenarioReturnPath ??
    billingReturnPath ??
    cliReturnPath ??
    apiKeysReturnPath ??
    appReturnPath ??
    "/";
  trackSignInReturnRestored(
    !appReturnPath
      ? "absent"
      : restoredPath === appReturnPath
        ? "restored"
        : "superseded",
  );
  const projectReturnIntent =
    createProjectSignInReturnRecoveryIntent(restoredPath);
  const specialReturn =
    scenarioReturnPath ??
    billingReturnPath ??
    cliReturnPath ??
    apiKeysReturnPath;
  const recoverToHome =
    !specialReturn &&
    transition?.path === restoredPath &&
    projectTransitionRecovery.isValid(transition);
  if (!recoverToHome) projectTransitionRecovery.clear();
  if (projectReturnIntent) {
    projectReturnIntent.fallback = specialReturn
      ? "preserve"
      : recoverToHome
        ? "home"
        : "none";
  }
  return { restoredPath, projectReturnIntent };
}

export function useCallbackProjectReturnRecovery(args: {
  intent: ProjectSignInReturnRecoveryIntent | null;
  membershipProjectIds: ReadonlySet<string> | undefined;
  fallbackProjectId: string | null;
  isCallback: boolean;
  ready: boolean;
  onResolved: () => void;
}) {
  const projectReturnRecoveryDecision = resolveProjectSignInReturnRecovery({
    intent: args.intent,
    membershipProjectIds: args.membershipProjectIds,
    fallbackProjectId: args.fallbackProjectId,
  });

  // Resolve while `/callback` still owns the screen. Clear the one-shot intent
  // before the only navigation so a bad destination can never loop.
  useLayoutEffect(() => {
    if (
      !args.isCallback ||
      !args.ready ||
      projectReturnRecoveryDecision.kind === "none" ||
      projectReturnRecoveryDecision.kind === "wait"
    ) {
      return;
    }
    projectTransitionRecovery.clear();
    args.onResolved();

    if (projectReturnRecoveryDecision.kind === "home") {
      trackStaleProjectReturnRecovered("no-fallback");
      navigateApp(routePaths.root, { replace: true, unscoped: true });
      return;
    }

    if (projectReturnRecoveryDecision.kind === "switch") {
      trackStaleProjectReturnRecovered("switched");
    }
    navigateApp(projectReturnRecoveryDecision.path, { replace: true });
  }, [
    projectReturnRecoveryDecision,
    args.isCallback,
    args.ready,
    args.onResolved,
  ]);
}
