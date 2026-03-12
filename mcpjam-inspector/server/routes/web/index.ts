import { Hono } from "hono";
import { webError, mapRuntimeError } from "./errors.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import resources from "./resources.js";
import prompts from "./prompts.js";
import chatV2 from "./chat-v2.js";
import apps from "./apps.js";
import oauthWeb from "./oauth.js";
import xrayPayload from "./xray-payload.js";
import exporter from "./export.js";
import guestSession from "./guest-session.js";
import { getGuestJwks } from "../../services/guest-token.js";

const web = new Hono();

// Require bearer auth + guest rate limiting on MCP operation routes
web.use("/servers/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/tools/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/resources/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/prompts/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chat-v2/*", bearerAuthMiddleware, guestRateLimitMiddleware);

web.route("/servers", servers);
web.route("/tools", tools);
web.route("/resources", resources);
web.route("/prompts", prompts);
web.route("/export", exporter);
web.route("/chat-v2", chatV2);
web.route("/apps", apps);
web.route("/oauth", oauthWeb);
web.route("/xray-payload", xrayPayload);
web.route("/guest-session", guestSession);

// Guest JWT JWKS endpoint — public, cacheable, no auth required.
// Convex fetches this to verify guest JWTs.
// Placed under /api/web/ so the SPA static file serving doesn't intercept it.
web.get("/guest-jwks", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(getGuestJwks());
});

web.onError((error, c) => {
  const routeError = mapRuntimeError(error);
  return webError(c, routeError.status, routeError.code, routeError.message);
});

export default web;
