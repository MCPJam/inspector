import { Hono } from "hono";
import { webError, mapRuntimeError } from "./errors.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import resources from "./resources.js";
import prompts from "./prompts.js";
import chatV2 from "./chat-v2.js";
import chatboxes from "./chatboxes.js";
import serverShares from "./server-shares.js";
import apps from "./apps.js";
import evals from "./evals.js";
import oauthWeb from "./oauth.js";
import xaaWeb from "./xaa.js";
import exporter from "./export.js";
import guestSession from "./guest-session.js";
import chatHistory from "./chat-history.js";
import conformanceWeb from "./conformance.js";
import { fetchRemoteGuestJwks } from "../../utils/guest-session-source.js";

const web = new Hono();

// Require bearer auth + guest rate limiting on MCP operation routes
web.use("/servers/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/tools/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/resources/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/prompts/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chatboxes/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/server-shares/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/evals/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chat-v2", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chat-history/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/conformance/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use(
  "/apps/mcp-apps/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware
);
web.use(
  "/apps/chatgpt-apps/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware
);

web.route("/servers", servers);
web.route("/tools", tools);
web.route("/resources", resources);
web.route("/prompts", prompts);
web.route("/chatboxes", chatboxes);
web.route("/server-shares", serverShares);
web.route("/evals", evals);
web.route("/export", exporter);
web.route("/chat-v2", chatV2);
web.route("/apps", apps);
web.route("/oauth", oauthWeb);
web.route("/xaa", xaaWeb);
web.route("/guest-session", guestSession);
web.route("/chat-history", chatHistory);
web.route("/conformance", conformanceWeb);

// Public guest JWKS compatibility endpoint.
web.get("/guest-jwks", async (c) => {
  const response = await fetchRemoteGuestJwks();
  if (!response) {
    return webError(c, 503, "INTERNAL_ERROR", "Guest JWKS unavailable");
  }

  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "Cache-Control":
        response.headers.get("cache-control") || "public, max-age=300",
      "Content-Type":
        response.headers.get("content-type") || "application/json",
    },
  });
});

web.onError((error, c) => {
  const routeError = mapRuntimeError(error);
  return webError(c, routeError.status, routeError.code, routeError.message);
});

export default web;
