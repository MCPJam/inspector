import { createSign, randomUUID } from "crypto";
import {
  GUEST_ISSUER,
  GUEST_KID,
  GUEST_TOKEN_TTL_S,
  getGuestPrivateKeyObjectOrThrow,
} from "./guest-token-keypair.js";

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

/**
 * Local guest signing helper kept for tests and non-hosted compatibility.
 * Hosted guest sessions are now minted by Convex.
 */
export function issueGuestToken(): {
  guestId: string;
  token: string;
  expiresAt: number;
} {
  const privateKey = getGuestPrivateKeyObjectOrThrow();
  const guestId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + GUEST_TOKEN_TTL_S;

  const header = { alg: "RS256", typ: "JWT", kid: GUEST_KID };
  const payload = { iss: GUEST_ISSUER, sub: guestId, iat: now, exp };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKey, "base64url");

  return {
    guestId,
    token: `${signingInput}.${signature}`,
    expiresAt: exp * 1000,
  };
}
