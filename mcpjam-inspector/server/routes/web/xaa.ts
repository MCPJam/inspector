import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import {
  authorizeXaaOrgIssuer,
  fetchServerClientSecret,
} from "../../utils/server-secrets.js";
import { createDerivedConfidentialCimdProviderFactory } from "@mcpjam/sdk";
import { createXaaRouter } from "../mcp/xaa.js";
import { CORS_ORIGINS } from "../../config.js";

/**
 * Parse the hosted-only master as exactly 32 random bytes encoded in unpadded
 * base64url. Unset disables derived confidential CIMD; a configured malformed
 * value is a deployment error and must fail before serving requests.
 */
export function readXaaCimdOrgMasterKey(
  raw: string | undefined = process.env.XAA_CIMD_ORG_MASTER_KEY
): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error(
      "XAA_CIMD_ORG_MASTER_KEY must be an unpadded base64url-encoded 32-byte secret"
    );
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== 32) {
    throw new Error(
      "XAA_CIMD_ORG_MASTER_KEY must decode to exactly 32 bytes"
    );
  }
  return decoded;
}

const xaaCimdOrgMasterKey = readXaaCimdOrgMasterKey();
const confidentialCimdProviderForOrg = xaaCimdOrgMasterKey
  ? createDerivedConfidentialCimdProviderFactory(xaaCimdOrgMasterKey)
  : undefined;

const xaaWeb = createXaaRouter({
  issuerBasePath: "/api/web",
  httpsOnlyProxy: true,
  trustForwardedHeaders: true,
  protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
  resolveServerSecret: (args) => fetchServerClientSecret(args),
  // Org-scoped issuer minting (/o/:orgId/...) is hosted-only: membership is
  // enforced by Convex with the caller's bearer.
  authorizeOrgIssuer: (args) => authorizeXaaOrgIssuer(args),
  ...(confidentialCimdProviderForOrg
    ? { confidentialCimdProviderForOrg }
    : {}),
  // The debugger drives /token from the browser; in dev the proxy's Origin
  // doesn't match the rewritten Host, and in production hosted these are the
  // app's own origins.
  allowedBrowserOrigins: CORS_ORIGINS,
});

export default xaaWeb;
