import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { createXaaRouter } from "../mcp/xaa.js";

const xaaWeb = createXaaRouter({
  issuerBasePath: "/api/web",
  httpsOnlyProxy: true,
  protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
});

export default xaaWeb;
