import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { fetchXaaResourceAppSecret } from "../../utils/server-secrets.js";
import { createXaaRouter } from "../mcp/xaa.js";

const xaaWeb = createXaaRouter({
  issuerBasePath: "/api/web",
  httpsOnlyProxy: true,
  trustForwardedHeaders: true,
  protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
  resolveRegistrationSecret: (args) => fetchXaaResourceAppSecret(args),
});

export default xaaWeb;
