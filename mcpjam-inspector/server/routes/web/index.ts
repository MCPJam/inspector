import { Hono } from "hono";
import { webError, webErrorFromRoute, mapRuntimeError } from "./errors.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { conformanceRunRateLimitMiddleware } from "../../middleware/conformance-run-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import resources from "./resources.js";
import tasksWeb from "./tasks.js";
import prompts from "./prompts.js";
import chatV2 from "./chat-v2.js";
import mcpjamAgent from "./mcpjam-agent.js";
import audioTranscriptions from "../mcp/audio-transcriptions.js";
import scenarios from "./scenarios.js";
import swarmRuns from "./swarm-runs.js";
import swarmGenerate from "./swarm-generate.js";
import { harnessMcp } from "./harness-mcp.js";
import apps from "./apps.js";
import evals from "./evals.js";
import environments from "./environments.js";
import oauthWeb from "./oauth.js";
import serverSecretsWeb from "./server-secrets.js";
import exporter from "./export.js";
import guestSession from "./guest-session.js";
import serverConnectionsWeb from "./server-connections.js";
import guestToken from "./guest-token.js";
import chatHistory from "./chat-history.js";
import conformanceWeb from "./conformance.js";
import conformanceShared from "./conformance-shared.js";
import sharedResources from "./shared-resources.js";
import score from "./score.js";
import bench from "./bench.js";
import checks from "./checks.js";
import apiKeys from "./api-keys.js";
import computers from "./computers.js";
import skills from "./skills.js";
import serverSkills from "./server-skills.js";
import caniuse from "./caniuse.js";
import mrtrContinuation from "./mrtr-continuation.js";
import registryWeb from "./registry.js";
import webmcpInspector from "../mcp/webmcp-inspector.js";
import { HOSTED_MODE } from "../../config.js";
import { fetchRemoteGuestJwks } from "../../utils/guest-session-source.js";

const web = new Hono();

// Require bearer auth + guest rate limiting on MCP operation routes
web.use("/servers/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/tools/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/resources/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/tasks/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/prompts/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/scenarios/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// Swarm (journey-execution) launch route — member-gated. The runner-control
// API it fronts is LAUNCHER-gated + project-member-gated server-side.
web.use("/swarm/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/evals/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// Project Environment reads — member-gated server-side by the Convex query the
// route fronts; client exposure is gated by the `project-environments-enabled`
// flag. Read-only and narrowly projected (never the full runtime spec).
web.use("/environments/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/chat-v2", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/mcpjam-agent", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use(
  "/mcpjam-agent/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware,
);
web.use("/chat-history/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/conformance/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/shared/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// Conformance runs dial a caller-named third party, so they carry a per-IP
// ceiling on top of the per-guest one — guest identities are free to mint, and
// only the IP bounds how much of our egress a single actor can spend.
//
// Scoped to the routes that START work. `/oauth/authorize` and
// `/oauth/complete` are the continuation of a run already paid for: charging
// them would let `/oauth/start` spend the last slot and then 429 the callback,
// stranding a session that can never finish. One run, one debit.
for (const startsWork of [
  "/conformance/protocol",
  "/conformance/apps",
  "/conformance/tasks",
  "/conformance/oauth/start",
]) {
  web.use(startsWork, conformanceRunRateLimitMiddleware);
}
// Connector Bench. Listed path-by-path rather than as `/bench/*` because
// `/bench/results/:secret` must stay reachable with no session at all — the
// secret in the URL is the credential, exactly as on `/score`. The per-IP
// ceiling on the two routes that START work lives inside the router, next to
// the egress it bounds.
for (const memberGated of [
  "/bench/preflight",
  "/bench/quotes",
  "/bench/runs",
  "/bench/runs/*",
]) {
  web.use(memberGated, bearerAuthMiddleware, guestRateLimitMiddleware);
}
web.use("/checks/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// Org-registry derivation carries a per-IP ceiling on top of the per-guest
// one. The route consumes that bucket only after it asks the backend whether
// this caller may add to the project's organization and before any egress.
web.use("/registry/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// Hosted MRTR continuation resume/cancel (MCP 2026-07-28 §12.5). Bearer +
// guest rate limit like every MCP-operation route; the resume path re-drives a
// tool/prompt/resource leg against a freshly-authorized manager.
web.use("/mrtr/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/server/*", bearerAuthMiddleware, guestRateLimitMiddleware);
// `/computers/exec` runs commands — bearer required. `/computers/config` is
// deliberately open: it returns only a boolean and a public URL, and the
// client needs it before any authed flow to know where the terminal lives.
web.use("/computers/exec", bearerAuthMiddleware, guestRateLimitMiddleware);
// The WebMCP Inspector, hosted. The SAME router the local inspector mounts at
// `/api/mcp/webmcp`, which is unreachable here — `/api/mcp/*` is 410'd in
// hosted mode — so it moves to the family that hosted actually serves.
//
// `requireVerifiedAuth` is the load-bearing part and is NOT redundant with the
// bearer middleware beside it. That one validates `sk_` keys and guest tokens
// but lets an unrecognized WorkOS JWT through unverified, on the stated
// understanding that routes forward the bearer to Convex and let Convex judge
// it. This router does that only when it establishes a session; afterwards it
// serves commands from an in-process map, and nothing downstream re-checks the
// caller. Without verification here, a bearer of any shape plus a session id
// would drive somebody else's browser.
web.use(
  "/webmcp/*",
  bearerAuthMiddleware,
  requireVerifiedAuth(),
  guestRateLimitMiddleware,
);
// Cloud Skills live on the caller's Computer (E2B sandbox); every op needs a
// bearer (forwarded to Convex for reserve/wake + authz).
web.use("/skills/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use("/server-skills/*", bearerAuthMiddleware, guestRateLimitMiddleware);
web.use(
  "/apps/mcp-apps/widget-content",
  bearerAuthMiddleware,
  guestRateLimitMiddleware,
);

web.route("/servers", servers);
web.route("/tools", tools);
web.route("/resources", resources);
web.route("/tasks", tasksWeb);
web.route("/prompts", prompts);
web.route("/scenarios", scenarios);
web.route("/swarm", swarmRuns);
web.route("/swarm", swarmGenerate);
web.route("/evals", evals);
web.route("/environments", environments);
web.route("/export", exporter);
// Voice transcription handles user-bearer forwarding and guest fallback inside
// the proxy route so local/npx users can spend MCPJam credits without BYOK.
web.route("/audio", audioTranscriptions);
web.route("/chat-v2", chatV2);
// Token-only (signed proxy token IS the auth) — NO bearerAuthMiddleware, like
// /guest-token. `sessionAuthMiddleware` already bypasses /api/web/*. The Claude
// Code harness (in a cloud sandbox) connects its MCP through here.
web.route("/harness-mcp", harnessMcp);
web.route("/mcpjam-agent", mcpjamAgent);
web.route("/apps", apps);
web.route("/oauth", oauthWeb);
web.route("/server", serverSecretsWeb);
web.route("/guest-session", guestSession);
// The handoff page's back end. Deliberately NOT behind bearerAuthMiddleware:
// after the claim, every step authenticates with the HttpOnly continuation
// cookie, and the claim itself is reachable by a signed-out guest who is about
// to authorize a server. The signed-in user's id is read opportunistically when
// the session middleware already resolved one.
web.route("/server-connections", serverConnectionsWeb);
// Service-token-gated guest minting for the platform MCP worker (anonymous
// /mcp sessions). Gated inside the router by `x-inspector-service-token`;
// `sessionAuthMiddleware` bypasses `/api/web/*` entirely.
web.route("/guest-token", guestToken);
web.route("/chat-history", chatHistory);
web.route("/conformance", conformanceWeb);
web.route("/checks", checks);
web.route("/mrtr", mrtrContinuation);
web.route("/registry", registryWeb);
// `/computers/terminal` (the WS) is registered on the root app in
// server/index.ts — only /config and /exec live on this sub-router.
web.route("/computers", computers);
// Hosted only. Locally the same router is mounted under `/api/mcp`, and
// mounting it twice would give one session two URLs.
if (HOSTED_MODE) {
  web.route("/webmcp", webmcpInspector);
}
web.route("/skills", skills);
// Skills served BY a connected MCP server (SEP-2640). A DISTINCT path from
// `/skills` above, which serves the project's durable Convex skills.
web.route("/server-skills", serverSkills);
// Public caniuse.dev correction reports. No bearer auth: the vanity compare
// surface is intentionally anonymous.
web.route("/caniuse", caniuse);
// score.mcpjam.com run storage. Deliberately NOT under `bearerAuthMiddleware`:
// a result link has to open for a visitor with no session at all, and the
// secret token in the URL is the credential. Submission is per-IP rate
// limited inside the router.
web.route("/score", score);
// Connector Bench relay for the same chrome-less site. Everything durable is
// the backend's; this fronts `/internal/v1/bench/*` and degrades cleanly while
// those routes are still behind `BENCHMARK_RUNS_ENABLED`.
web.route("/bench", bench);
// Shared conformance run (HMAC token in the path). Same no-session contract
// as `/score`: the token is the credential, and the backend only returns the
// redacted public artifact.
web.route("/conformance-shared", conformanceShared);
web.route("/shared", sharedResources);
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
  // `webErrorFromRoute`, not a hand-rolled `webError` call: the mapped error
  // carries the EFFECTIVE origin (post internal-boundary promotion), and
  // passing only `normalized` here discarded it at the very last step — for
  // every handler on /api/web/* that throws rather than returns. That drop
  // was the single largest reason `origin=mcpjam` never appeared in Axiom.
  const routeError = mapRuntimeError(error);
  return webErrorFromRoute(c, routeError);
});

export default web;
