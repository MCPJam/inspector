/// <reference types="node" />

function normalizeIssuer(domain: string): string {
  const trimmed = domain.replace(/\/+$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

const authkitDomain = process.env.AUTHKIT_DOMAIN;
if (!authkitDomain) {
  throw new Error("Missing AUTHKIT_DOMAIN.");
}

const issuer = normalizeIssuer(authkitDomain);

export default {
  providers: [
    {
      type: "customJwt",
      issuer,
      algorithm: "RS256",
      jwks: new URL("/oauth2/jwks", issuer).toString(),
    },
  ],
};
