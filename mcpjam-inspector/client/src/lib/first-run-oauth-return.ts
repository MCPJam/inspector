import { getHostedOAuthCallbackContext } from "./hosted-oauth-callback";
import { readFirstRunServerChoiceState } from "./onboarding-state";

export const FIRST_RUN_OAUTH_OVERLAY_READY_EVENT =
  "mcpjam:first-run-oauth-overlay-ready";
export const FIRST_RUN_OAUTH_CANCELLED_EVENT =
  "mcpjam:first-run-oauth-cancelled";

export function getFirstRunOAuthReturnServerName(): string | null {
  if (
    window.location.pathname !== "/oauth/callback" &&
    !window.location.pathname.startsWith("/oauth/callback/")
  ) {
    return null;
  }
  const firstRunState = readFirstRunServerChoiceState();
  if (
    firstRunState?.status !== "started" ||
    !firstRunState.attemptedServerName
  ) {
    return null;
  }
  const callbackContext = getHostedOAuthCallbackContext();
  return callbackContext?.surface === "project" &&
    callbackContext.serverName === firstRunState.attemptedServerName
    ? firstRunState.attemptedServerName
    : null;
}
