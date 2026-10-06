/**
 * The backend's guest-session hash pepper, used to key the hashed client-IP
 * bucket this Inspector forwards with guest calls.
 *
 * It is a BACKEND credential: the same value the Convex deployment uses, so it
 * comes from the selected profile's environment and nowhere else. It is never
 * generated locally or read from `~/.mcpjam` — a locally invented pepper keys
 * buckets the backend cannot match, and one inherited from another target
 * mixes two backends' identities. Absent, callers degrade to cookie-only guest
 * limits (see `guest-spend-ip.ts`).
 */
export function getGuestSessionHashPepper(): string {
  const value = process.env.GUEST_SESSION_HASH_PEPPER?.trim();
  if (!value) {
    throw new Error(
      "GUEST_SESSION_HASH_PEPPER is not configured for the selected profile",
    );
  }
  return value;
}
