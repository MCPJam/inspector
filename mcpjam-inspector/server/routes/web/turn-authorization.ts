import { verifyAuthKitToken } from "../../services/authkit-jwt.js";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isAbortError } from "../../../shared/abort-errors.js";
import { turnAuthorizationIdentity } from "../../../shared/turn-authorization.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { turnAuthorizations } from "../../services/turn-authorization.js";
import { abortable } from "../../services/sessionSimulation/target-discovery.js";
import { authorizeProject, callerContextFromHono, readJsonBody, parseWithSchema, webErrorFromRoute } from "./auth.js";
import { mapWebBoundaryError } from "./boundary-error.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const routes = new Hono();
routes.use("*", bearerAuthMiddleware, requireVerifiedAuth());
routes.post("/", async (c) => {
  try {
    const identity = parseWithSchema(turnAuthorizationIdentity, await abortable(readJsonBody(c), c.req.raw.signal));
    const subject = c.get("workosUserId");
    const sessionId = c.get("workosSessionId");
    if (c.get("authMethod") !== "authkit_jwt" || typeof subject !== "string" || typeof sessionId !== "string")
      return c.json({ error: "Sign in to renew this turn." }, 401);
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const verified = await abortable(verifyAuthKitToken(token, undefined, { allowMcpResourceAudience: true }), c.req.raw.signal);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]);
    await abortable(authorizeProject(callerContextFromHono(c), token, identity.projectId), signal);
    signal.throwIfAborted();
    const renewed = await abortable(turnAuthorizations.renew(identity, { subject, sessionId,
      organizationId: verified.orgId }, token), signal);
    return c.json({ renewed: true, ...renewed });
  } catch (error) {
    // A closed caller needs no renewal; unrelated failures still retain their classification.
    if (c.req.raw.signal.aborted &&
      (error === c.req.raw.signal.reason || isAbortError(error)))
      return c.json({ error: "Request cancelled" }, 499 as ContentfulStatusCode);
    reportRouteFailure("Failed to renew a running turn", error, { source: "chat.authorization.renew", hop: "mcpjam_internal" });
    return webErrorFromRoute(c, mapWebBoundaryError(error));
  }
});
export default routes;
