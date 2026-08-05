import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
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
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

const servers = new Hono();

const serverFields = {
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  transportType: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  hasBearerToken: z.boolean().optional(),
  timeout: z.number().finite().positive().optional(),
  clientCapabilities: z.unknown().optional(),
  useOAuth: z.boolean().optional(),
  oauthScopes: z.array(z.string()).optional(),
  clientId: z.string().optional(),
  oauthResourceUrl: z.string().optional(),
  oauthProtocolMode: z.string().optional(),
  oauthProtocolVersion: z.string().optional(),
  oauthRegistrationStrategy: z.string().optional(),
  xaaAuthzIssuer: z.string().optional(),
  xaaAllowPathScopedIssuer: z.boolean().optional(),
  oauthAllowPathScopedIssuer: z.boolean().optional(),
  useXaa: z.boolean().optional(),
  authServerMode: z.enum(["mcpjam", "own"]).optional(),
  xaaSubject: z.string().optional(),
  xaaEmail: z.string().optional(),
  xaaIdentityAssertionFormat: z.string().optional(),
  xaaClientAuth: z.string().optional(),
  authMethod: z.string().optional(),
  registrationMode: z.string().optional(),
  clientSecret: z.string().optional(),
};

const createServerSchema = z.object(serverFields).passthrough();
const updateServerSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(serverFields).map(([key, schema]) => [
        key,
        schema.optional(),
      ])
    ),
    clearClientSecret: z.boolean().optional(),
    clearXaaConfig: z.boolean().optional(),
  })
  .passthrough()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  });

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

function translateServerWriteError(error: unknown): WebRouteError {
  const data =
    typeof error === "object" && error !== null
      ? (error as { data?: unknown }).data
      : undefined;
  if (typeof data === "object" && data !== null) {
    const structured = data as { code?: unknown; message?: unknown };
    if (structured.code === "CONFLICT") {
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        String(structured.message ?? "Server name already exists")
      );
    }
    if (structured.code === "NOT_FOUND") {
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        String(structured.message ?? "Server not found")
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|duplicate|name conflict/i.test(message)) {
    return new WebRouteError(409, ErrorCode.CONFLICT, message);
  }
  if (/not found|not a member|unauthorized/i.test(message)) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found");
  }
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    message.split("\n")[0] || "Server write rejected"
  );
}

async function findProjectServer(
  token: string,
  projectId: string,
  serverId: string
) {
  const rows = (await convexClient(token).query(
    "servers:getProjectServers" as any,
    { projectId } as any
  )) as Array<Record<string, unknown>>;
  const row = rows.find(
    (candidate) => String(candidate._id ?? candidate.id) === serverId
  );
  if (!row)
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found");
  return {
    id: String(row._id ?? row.id),
    projectId: row.projectId ?? projectId,
    name: row.name,
    enabled: row.enabled,
    transportType: row.transportType,
    url: row.url ?? null,
    useOAuth: row.useOAuth === true,
    hasClientSecret: row.hasClientSecret === true,
    oauthScopes: row.oauthScopes ?? [],
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function readJsonObject(
  c: Parameters<typeof synthesizeServerBody>[0]
): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body"
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be a JSON object"
    );
  }
  return value as Record<string, unknown>;
}

// POST /v1/projects/:projectId/servers — create a saved server.
servers.post("/projects/:projectId/servers", async (c) => {
  const projectId = c.req.param("projectId");
  const body = parseWithSchema(createServerSchema, await readJsonObject(c));
  const token = await getConvexBearerForRequest(c);
  try {
    const serverId = await convexClient(token).action(
      "servers:createServerWithClientSecret" as any,
      {
        ...body,
        projectId,
        failOnNameConflict: true,
      } as any
    );
    return v1Resource(
      c,
      await findProjectServer(token, projectId, String(serverId)),
      201
    );
  } catch (error) {
    throw translateServerWriteError(error);
  }
});

// GET /v1/projects/:projectId/servers/:serverId — one saved server.
servers.get("/projects/:projectId/servers/:serverId", async (c) => {
  const token = await getConvexBearerForRequest(c);
  return v1Resource(
    c,
    await findProjectServer(
      token,
      c.req.param("projectId"),
      c.req.param("serverId")
    )
  );
});

// PATCH /v1/projects/:projectId/servers/:serverId — update metadata/secrets.
servers.patch("/projects/:projectId/servers/:serverId", async (c) => {
  const projectId = c.req.param("projectId");
  const serverId = c.req.param("serverId");
  const body = parseWithSchema(updateServerSchema, await readJsonObject(c));
  const token = await getConvexBearerForRequest(c);
  try {
    await convexClient(token).action(
      "servers:updateServerWithClientSecret" as any,
      {
        ...body,
        projectId,
        serverId,
      } as any
    );
    return v1Resource(c, await findProjectServer(token, projectId, serverId));
  } catch (error) {
    throw translateServerWriteError(error);
  }
});

// DELETE /v1/projects/:projectId/servers/:serverId — soft-delete a server.
servers.delete("/projects/:projectId/servers/:serverId", async (c) => {
  const projectId = c.req.param("projectId");
  const serverId = c.req.param("serverId");
  const body = await readJsonObject(c);
  if (Object.keys(body).length > 0)
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Delete body must be empty"
    );
  const token = await getConvexBearerForRequest(c);
  try {
    await convexClient(token).mutation(
      "servers:deleteServer" as any,
      { projectId, serverId } as any
    );
  } catch (error) {
    throw translateServerWriteError(error);
  }
  return v1Resource(c, { id: serverId, deleted: true });
});

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
servers.post(
  "/projects/:projectId/servers/:serverId/check-oauth",
  async (c) => {
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
  }
);

export default servers;
