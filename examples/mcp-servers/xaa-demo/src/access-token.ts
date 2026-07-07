import { SignJWT, jwtVerify } from "jose";

// Mint the keycard (access token). It is stamped with the address (`aud`) it is
// good for — the resource the pass asked for.
export function mintAccessToken(args: {
  subject: string;
  audience: string;
  scope?: string;
  issuer: string;
  secret: Uint8Array;
}): Promise<string> {
  return new SignJWT({ ...(args.scope ? { scope: args.scope } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(args.issuer)
    .setSubject(args.subject)
    .setAudience(args.audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(args.secret);
}

// Verify a keycard at the door. Passing `audience` makes jose throw on a
// mismatch — this IS the door's address check.
export async function verifyAccessToken(
  token: string,
  opts: { issuer: string; audience: string; secret: Uint8Array },
): Promise<void> {
  await jwtVerify(token, opts.secret, {
    issuer: opts.issuer,
    audience: opts.audience,
  });
}
