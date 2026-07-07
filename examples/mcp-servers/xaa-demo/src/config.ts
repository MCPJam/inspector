import type { Request } from "express";
import { randomBytes } from "node:crypto";

// A per-process secret is fine for a toy: this server both mints and verifies
// its own access tokens, so the keycard never needs to be validated elsewhere.
const ACCESS_TOKEN_SECRET = randomBytes(32);

export function getConfig() {
  const trusted = (process.env.TRUSTED_ISSUER ?? "").trim();
  return {
    port: Number(process.env.PORT ?? 8080),
    canonicalUrl: (
      process.env.CANONICAL_URL ?? "https://demo.example.com/mcp"
    ).trim(),
    trustedIssuer: trusted === "" ? null : trusted,
    accessTokenSecret: ACCESS_TOKEN_SECRET,
  };
}

export function selfOrigin(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

export function resourceUrl(req: Request): string {
  return `${selfOrigin(req)}/mcp`;
}

export function asIssuer(req: Request): string {
  return selfOrigin(req);
}
