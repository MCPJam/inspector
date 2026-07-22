import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import {
  authorizeXaaOrgIssuer,
  fetchServerClientSecret,
} from "../../utils/server-secrets.js";
import { createXaaRouter } from "../mcp/xaa.js";
import { CORS_ORIGINS } from "../../config.js";
import {
  getConfidentialCimdProviderForOrg,
  readXaaCimdOrgMasterKey,
} from "../../services/xaa-confidential-cimd.js";

export { readXaaCimdOrgMasterKey };

export function createXaaWebRouter() {
  const confidentialCimdProviderForOrg =
    getConfidentialCimdProviderForOrg();
  return createXaaRouter({
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
}
