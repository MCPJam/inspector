import { getOrCreateLocalSecret } from "./local-secret-store.js";

export function getGuestSessionHashPepper(): string {
  return getOrCreateLocalSecret({
    fileName: "guest-session-hash-pepper.txt",
    envVar: "GUEST_SESSION_HASH_PEPPER",
    productionErrorMessage:
      "GUEST_SESSION_HASH_PEPPER is required for guest session hashing",
    label: "guest session hash pepper",
  });
}
