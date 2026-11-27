import { isLoopbackOAuthUrl } from "@mcpjam/sdk/browser";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";
import {
  trackSignInFailedBeforeRedirect,
  trackSignInStarted,
  type SignInAttempt,
} from "./signin-tracking";

export type WorkosAuthStartResult = "started" | "blocked";

export function isUnsupportedWorkosAuthOrigin(origin: string): boolean {
  return (
    origin !== "null" &&
    new URL(origin).protocol === "http:" &&
    !isLoopbackOAuthUrl(origin)
  );
}

export async function startWorkosAuth(
  start: () => void | Promise<void>,
  attempt: SignInAttempt,
  origin = globalThis.location.origin,
): Promise<WorkosAuthStartResult> {
  const attemptId = trackSignInStarted(attempt);
  // WorkOS production callbacks require HTTPS outside loopback, even if a
  // browser exposes Web Crypto on an explicitly trusted HTTP origin.
  if (isUnsupportedWorkosAuthOrigin(origin)) {
    trackSignInFailedBeforeRedirect(attemptId, attempt, "insecure_origin");
    useWorkosAuthUnavailableStore.getState().show();
    return "blocked";
  }
  try {
    await start();
  } catch (error) {
    trackSignInFailedBeforeRedirect(attemptId, attempt, "start_error");
    throw error;
  }
  return "started";
}
