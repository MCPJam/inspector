import type { AuthChallengeSignal } from "@mcpjam/sdk/browser";
import { authChallengeFromError } from "@/lib/apis/insufficient-scope";
import type { AuthChallengePresentation } from "@/lib/auth-challenge-lifecycle";

/**
 * Whether a caught error carries a sign-in challenge that the surface presents
 * as a Connect card or a notice. Those replace the raw error. A 403
 * `insufficient_scope` is a step-up, not a sign-in, and keeps its error.
 */
export function isSignInChallengeError(error: unknown): boolean {
  const signal = authChallengeFromError(error);
  return Boolean(signal && signal.source !== "http_403_insufficient_scope");
}

/**
 * The error a call shows when the emulated host passes its sign-in challenge
 * through, or `null` when the card or notice is the whole message.
 *
 * A pass-through host treats the refusal as an ordinary failure, so the call
 * must still read as failed. The text comes from the parsed challenge, not the
 * transport error: hosted reports a sign-in request as 403
 * UPSTREAM_AUTH_FAILED, which would read as a permissions problem. The notice
 * beside it names the 401 and what the host needs, so this line does not. A
 * `_meta` challenge arrives on a completed result, which shows on its own.
 */
export function passthroughChallengeErrorText(
  presentation: AuthChallengePresentation,
  signal: AuthChallengeSignal,
): string | null {
  if (presentation.kind !== "notice" || presentation.reason !== "passthrough")
    return null;
  if (signal.source !== "http_401") return null;
  const description = signal.errorDescription?.trim();
  const failed = "The server asked for sign-in, so the call failed.";
  // The selected client is why there was no sign-in, so its settings are
  // the step the user can take here.
  const nextStep =
    "To change how this client responds, edit Mid-session sign-in in its Connect settings.";
  if (!description) return `${failed} ${nextStep}`;
  const said = /[.!?]$/.test(description) ? description : `${description}.`;
  return `${failed} The server said: ${said} ${nextStep}`;
}
