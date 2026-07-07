import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";

// Verify the incoming signed pass (ID-JAG). We read its issuer, discover that
// issuer's public keys, then check the signature AND that the pass is addressed
// to THIS authorization server. Throws on anything invalid.
export async function verifyIdJag(
  assertion: string,
  opts: { audience: string; trustedIssuer: string | null },
): Promise<{ sub: string; resource: string; scope?: string }> {
  const iss = decodeJwt(assertion).iss;
  if (typeof iss !== "string") throw new Error("pass has no issuer");
  if (opts.trustedIssuer && iss !== opts.trustedIssuer) {
    throw new Error(`untrusted issuer: ${iss}`);
  }
  const oidc = await fetch(`${iss}/.well-known/openid-configuration`).then((r) =>
    r.json(),
  );
  const jwks = createRemoteJWKSet(new URL(oidc.jwks_uri));
  // Passing `audience` makes jose reject a pass addressed to a different server.
  const { payload } = await jwtVerify(assertion, jwks, {
    audience: opts.audience,
  });
  if (typeof payload.sub !== "string") throw new Error("pass has no subject");
  if (typeof payload.resource !== "string")
    throw new Error("pass has no resource");
  return {
    sub: payload.sub,
    resource: payload.resource,
    scope: payload.scope as string | undefined,
  };
}
