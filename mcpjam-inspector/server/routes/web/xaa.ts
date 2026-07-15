import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import {
  authorizeXaaOrgIssuer,
  evaluateXaaIssuerPolicy,
  fetchServerClientSecret,
  fetchXaaResourceAppSecret,
} from "../../utils/server-secrets.js";
import { createXaaRouter } from "../mcp/xaa.js";
import { CORS_ORIGINS } from "../../config.js";

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
  // Managed-IdP policy over org-scoped mints, also hosted-only: the local
  // router wires neither this nor authorizeOrgIssuer, so enforcement being
  // hosted-only falls out structurally.
  evaluateIssuerPolicy: (args) => evaluateXaaIssuerPolicy(args),
  // The debugger drives /token from the browser; in dev the proxy's Origin
  // doesn't match the rewritten Host, and in production hosted these are the
  // app's own origins.
  allowedBrowserOrigins: CORS_ORIGINS,
});

export default xaaWeb;
