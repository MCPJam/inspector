import { validateGuestTokenDetailedAsync } from "../services/guest-token.js";
import { verifyAuthKitToken } from "../services/authkit-jwt.js";
import { checkSessionRevocation } from "../services/revoked-session-cache.js";
import { flagAccountEmail } from "./flag-account.js";

/**
 * Whose feature flags a request gets: a verified id, nobody, or a signed-out
 * session. Shared by `GET /api/web/flags` and server-side rollout gates, so a
 * flag the browser reads and the gate the server enforces resolve the same
 * identity from the same bearer.
 */
export type FlagsIdentity =
  | { kind: "id"; distinctId: string; member?: boolean; email?: string }
  | { kind: "none" }
  | { kind: "revoked" };

export const NO_FLAGS_IDENTITY: FlagsIdentity = { kind: "none" };

/** The identity a bearer token verifies as, with the member's account email. */
export async function verifiedFlagIdentity(
  token: string,
): Promise<FlagsIdentity> {
  const identity = await verifiedFlagSubject(token);
  return identity.kind === "id" && identity.member
    ? { ...identity, email: await flagAccountEmail(token, identity.distinctId) }
    : identity;
}

/**
 * The identity a bearer token verifies as: a guest token, then AuthKit. No
 * account lookup, so a caller holding a cached answer for this id can skip it.
 */
export async function verifiedFlagSubject(
  token: string,
): Promise<FlagsIdentity> {
  try {
    const guest = await validateGuestTokenDetailedAsync(token);
    if (guest.valid && guest.guestId) {
      return { kind: "id", distinctId: guest.guestId };
    }
  } catch {
    // Guest token service unavailable; the AuthKit check below still runs.
  }
  let session: Awaited<ReturnType<typeof verifyAuthKitToken>>;
  try {
    session = await verifyAuthKitToken(token);
  } catch {
    return NO_FLAGS_IDENTITY;
  }
  // The check `bearerAuthMiddleware` applies to every AuthKit bearer: a
  // session this process knows to be signed out is refused (MJ-011).
  if (!checkSessionRevocation(session.sid, { requireFresh: false }).ok) {
    return { kind: "revoked" };
  }
  return { kind: "id", distinctId: session.sub, member: true };
}
