import { validateGuestToken } from "../../services/guest-token-verifier.js";

/**
 * Is this chat request a GUEST (for local-engine eligibility)?
 *
 * The local computer engine runs bash on the machine as the user, with NO
 * backend reserve gate (unlike the cloud path, which the backend rejects for
 * guests) — so this request-level guest check IS the security boundary.
 *
 *  - No Authorization ⇒ anonymous guest (the route mints a guest bearer later).
 *  - A PRESENT bearer can still be a guest bearer: a signed-out user's turn
 *    attaches one, and a consent token can outlive sign-out — so validate it.
 *  - Guest keys uninitialized ⇒ guest tokens can't exist ⇒ a present bearer is
 *    a member bearer.
 */
export function isGuestChatRequest(authHeader: string | undefined): boolean {
  if (!authHeader) return true;
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  if (!bearer) return true;
  try {
    return validateGuestToken(bearer).valid;
  } catch {
    return false;
  }
}
