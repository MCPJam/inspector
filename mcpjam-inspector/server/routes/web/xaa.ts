import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import {
  authorizeXaaOrgIssuer,
  fetchServerClientSecret,
  fetchXaaResourceAppSecret,
} from "../../utils/server-secrets.js";
import { createXaaRouter } from "../mcp/xaa.js";
import { XAA_OIDC_ENABLED } from "../../config.js";

const xaaWeb = createXaaRouter({
  issuerBasePath: "/api/web",
  httpsOnlyProxy: true,
  trustForwardedHeaders: true,
  protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
  resolveRegistrationSecret: (args) => fetchXaaResourceAppSecret(args),
  resolveServerSecret: (args) => fetchServerClientSecret(args),
  // Org-scoped issuer minting (/o/:orgId/...) is hosted-only: membership is
  // enforced by Convex with the caller's bearer.
  authorizeOrgIssuer: (args) => authorizeXaaOrgIssuer(args),
  enableOidcMode: XAA_OIDC_ENABLED,
});

export default xaaWeb;
