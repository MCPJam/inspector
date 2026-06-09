import { Hono } from "hono";
import {
  projectServerSchema,
  authorizeServer,
  assertBearerToken,
  parseWithSchema,
} from "../web/auth.js";
import { runHostedDoctor, validateServerCore } from "../web/servers.js";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import { runV1ServerOp, synthesizeServerBody } from "./adapter.js";
import { v1Resource } from "./envelope.js";

const servers = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/validate
// Connect to the server and capture an inspection snapshot. Wraps the same
// validateServerCore the web /servers/validate route uses.
servers.post("/projects/:projectId/servers/:serverId/validate", async (c) =>
  runV1ServerOp(
    c,
    projectServerSchema,
    (manager, body) => validateServerCore(c, manager, body),
    (ctx, result) => v1Resource(ctx, result),
    { timeoutMs: WEB_CONNECT_TIMEOUT_MS }
  )
);

// POST /v1/projects/:projectId/servers/:serverId/doctor
// Run the shared SDK doctor workflow (probe -> connect -> initialize ->
// capabilities). runHostedDoctor authorizes + runs runServerDoctor itself, so
// it does not go through the ephemeral-manager path.
servers.post("/projects/:projectId/servers/:serverId/doctor", async (c) => {
  const rawBody = await synthesizeServerBody(c);
  const result = await runHostedDoctor(c, rawBody, WEB_CONNECT_TIMEOUT_MS);
  return v1Resource(c, result);
});

// POST /v1/projects/:projectId/servers/:serverId/check-oauth
// Lightweight authorize-only probe: does this server require OAuth, and what's
// its URL. No MCP connection.
servers.post("/projects/:projectId/servers/:serverId/check-oauth", async (c) => {
  const rawBody = await synthesizeServerBody(c);
  const bearerToken = assertBearerToken(c);
  const body = parseWithSchema(projectServerSchema, rawBody);
  const auth = await authorizeServer(
    c,
    bearerToken,
    body.projectId,
    body.serverId,
    {
      accessScope: body.accessScope,
      chatboxId: body.chatboxId,
      accessVersion: body.accessVersion,
    }
  );
  return v1Resource(c, {
    useOAuth: auth.serverConfig.useOAuth ?? false,
    serverUrl: auth.serverConfig.url ?? null,
  });
});

export default servers;
