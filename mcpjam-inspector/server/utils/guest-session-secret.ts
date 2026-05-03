import { getOrCreateLocalSecret } from "./local-secret-store.js";

export const GUEST_SESSION_SECRET_HEADER = "x-mcpjam-guest-session-secret";

export function getGuestSessionSharedSecret(): string {
  return getOrCreateLocalSecret({
    fileName: "guest-session-shared-secret.txt",
    envVar: "MCPJAM_GUEST_SESSION_SHARED_SECRET",
    productionErrorMessage:
      "MCPJAM_GUEST_SESSION_SHARED_SECRET is required for guest session proxying",
    label: "guest session shared secret",
  });
}
