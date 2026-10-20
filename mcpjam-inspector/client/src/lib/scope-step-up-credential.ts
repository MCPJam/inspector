/**
 * Which credential a step-up (or a mid-session sign-in) authorizes, and
 * whether the saved call may be replayed with the result.
 *
 * A redirect for one tool call must never silently move the user onto, or
 * overwrite, a credential that is not theirs:
 *
 * | Credential the call used                  | Sign-in            | Saved call          |
 * |-------------------------------------------|--------------------|---------------------|
 * | none (tokenless; first sign-in)           | create             | replayed            |
 * | owned personal credential                 | replace that one   | replayed            |
 * | shared (project) or someone else's        | create, never      | cancelled: run it   |
 * |                                           | replace            | again               |
 * | owned, but the callback names another one | (account switch)   | cancelled           |
 *
 * The binding is recorded on the pending stores before the redirect and
 * settled on the callback.
 */

import type { ConnectionIntent } from "@/shared/oauth-connections";

export type StepUpCredentialBinding =
  | { kind: "none" }
  | { kind: "owned"; credentialId: string }
  | { kind: "shared"; credentialId?: string };

export function isStepUpCredentialBinding(
  value: unknown,
): value is StepUpCredentialBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as { kind?: unknown; credentialId?: unknown };
  if (binding.kind === "none") return true;
  if (binding.kind === "owned") {
    return (
      typeof binding.credentialId === "string" && binding.credentialId !== ""
    );
  }
  return (
    binding.kind === "shared" &&
    (binding.credentialId === undefined ||
      typeof binding.credentialId === "string")
  );
}

/**
 * The hosted OAuth intent a binding signs in with. `undefined` is the classic
 * first-credential flow; a shared credential is never replaced.
 */
export function connectionIntentForBinding(
  binding: StepUpCredentialBinding | undefined,
): ConnectionIntent | undefined {
  if (!binding || binding.kind === "none") return undefined;
  if (binding.kind === "owned") {
    return { kind: "replace", credentialId: binding.credentialId };
  }
  return { kind: "add" };
}

export const SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE =
  "Signed in with your own account. Run the tool again to use it; the earlier call was not retried.";
export const SIGNED_IN_WITH_DIFFERENT_ACCOUNT_MESSAGE =
  "Signed in with a different account than the call used, so it was not retried. Run the tool again.";

/**
 * Whether a saved call may be replayed after the callback completed.
 * `callbackCredentialId` is the credential the authorization produced, when
 * the callback reports one.
 */
export function settleStepUpCredential(
  binding: StepUpCredentialBinding | undefined,
  callbackCredentialId: string | undefined,
): { outcome: "replay" } | { outcome: "cancel"; message: string } {
  if (!binding || binding.kind === "none") return { outcome: "replay" };
  if (binding.kind === "shared") {
    return { outcome: "cancel", message: SIGNED_IN_WITH_OWN_ACCOUNT_MESSAGE };
  }
  if (
    callbackCredentialId !== undefined &&
    callbackCredentialId !== binding.credentialId
  ) {
    return {
      outcome: "cancel",
      message: SIGNED_IN_WITH_DIFFERENT_ACCOUNT_MESSAGE,
    };
  }
  return { outcome: "replay" };
}
