import { Hono } from "hono";
import { webError, mapRuntimeError } from "./errors.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import resources from "./resources.js";
import prompts from "./prompts.js";
import chatV2 from "./chat-v2.js";
import mcpjamAgent from "./mcpjam-agent.js";
import chatboxes from "./chatboxes.js";
import chatboxSessions from "./chatbox-sessions.js";
import apps from "./apps.js";
import evals from "./evals.js";
import oauthWeb from "./oauth.js";
import serverSecretsWeb from "./server-secrets.js";
import xaaWeb from "./xaa.js";
import exporter from "./export.js";
import guestSession from "./guest-session.js";
import guestToken from "./guest-token.js";
import chatHistory from "./chat-history.js";
import conformanceWeb from "./conformance.js";
import checks from "./checks.js";
import apiKeys from "./api-keys.js";
import computers from "./computers.js";
import { fetchRemoteGuestJwks } from "../../utils/guest-session-source.js";

const web = new Hono();

// Require bearer auth + guest rate limiting on MCP operation routes
web.use("/servers/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/tools/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/resources/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/prompts/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chatboxes/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/evals/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chat-v2", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/mcpjam-agent", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use(
  "/mcpjam-agent/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware
);
web.use("/chat-history/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/conformance/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/checks/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/server/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// `/computers/exec` runs commands — bearer required. `/computers/config` is
// deliberately open: it returns only a boolean and a public URL, and the
// client needs it before any authed flow to know where the terminal lives.
web.use("/computers/exec", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use(
  "/apps/mcp-apps/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware
);

web.route("/servers", servers);
web.route("/tools", tools);
web.route("/resources", resources);
web.route("/prompts", prompts);
web.route("/chatboxes", chatboxes);
web.route("/chatboxes", chatboxSessions);
web.route("/evals", evals);
web.route("/export", exporter);
web.route("/chat-v2", chatV2);
web.route("/mcpjam-agent", mcpjamAgent);
web.route("/apps", apps);
web.route("/oauth", oauthWeb);
web.route("/server", serverSecretsWeb);
web.route("/xaa", xaaWeb);
web.route("/guest-session", guestSession);
// Service-token-gated guest minting for the platform MCP worker (anonymous
// /mcp sessions). Gated inside the router by `x-inspector-service-token`;
// `sessionAuthMiddleware` bypasses `/api/web/*` entirely.
web.route("/guest-token", guestToken);
web.route("/chat-history", chatHistory);
web.route("/conformance", conformanceWeb);
web.route("/checks", checks);
// `/computers/terminal` (the WS) is registered on the root app in
// server/index.ts — only /config and /exec live on this sub-router.
web.route("/computers", computers);
// `/api-keys` carries its own bearer-auth `.use()` because
// `sessionAuthMiddleware` bypasses `/api/web/*` entirely. Nothing on this
// sub-router is reachable without a session JWT (WorkOS `sk_…` keys are
// explicitly rejected with 403 inside the router).
web.route("/api-keys", apiKeys);

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
  return webError(
    c,
    routeError.status,
    routeError.code,
    routeError.message,
    routeError.details,
    routeError.normalized ? { normalized: routeError.normalized } : undefined
  );
});

export default web;
