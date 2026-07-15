import { sign as cryptoSign, randomUUID } from "crypto";
import {
  getXaaClientPrivateKey,
  XAA_CLIENT_KID,
} from "./client-keypair.js";

// Signs the RFC 7523 `private_key_jwt` client assertion the RAS verifies for
// confidential CIMD. ES256 via `dsaEncoding: "ieee-p1363"`, which produces the
// raw r‖s signature JOSE requires (Node's default ECDSA output is DER). Node-only.

const CLIENT_ASSERTION_TTL_S = 5 * 60;

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString(
    "base64url",
  );
}

/**
 * Build a signed `private_key_jwt` client assertion for the confidential CIMD
 * client. Claims per RFC 7523 §3 / the worker's `authenticateCimdClient`:
 * `iss = sub = clientId` (the CIMD document URL), `aud = tokenEndpoint`, plus a
 * unique `jti` and a short `exp`.
 */
export function signClientAssertion(args: {
  clientId: string;
  tokenEndpoint: string;
  nowSeconds?: number;
}): string {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: XAA_CLIENT_KID };
  const payload = {
    iss: args.clientId,
    sub: args.clientId,
    aud: args.tokenEndpoint,
    jti: randomUUID(),
    iat: now,
    exp: now + CLIENT_ASSERTION_TTL_S,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: getXaaClientPrivateKey(),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}
