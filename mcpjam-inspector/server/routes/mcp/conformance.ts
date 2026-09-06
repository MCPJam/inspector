import { Hono } from "hono";
import { z } from "zod";
import {
  MCP_PROTOCOL_VERSIONS,
  canRunConformance,
  oauthConformanceProfileSchema,
  type HttpServerConfig,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import "../../types/hono";
import {
  OAuthConformanceSessionFailedError,
  OAuthConformanceSessionNotFoundError,
  UnsupportedTransportError,
  assertHttpSupported,
  completeOAuthConformance,
  runAppsConformance,
  runLocalDirectoryReadiness,
  runProtocolConformance,
  runTasksConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "../shared/conformance";
import { reportRouteFailure, readRequestJson } from "../../utils/route-error-report.js";

const conformance = new Hono();

// ── Helpers ─────────────────────────────────────────────────────────────

type ServerConfigResolution =
  | { config: MCPServerConfig }
  | { error: string; code: string };

function resolveServerConfig(
  mcpClientManager: any,
  serverId: string,
): ServerConfigResolution {
  const serverConfig = mcpClientManager.getServerConfig(serverId) as
    | MCPServerConfig
    | undefined;
  if (!serverConfig) {
    return { error: "Server not connected", code: "notConnected" };
  }
  return { config: serverConfig };
}

function toHttpResolved(config: HttpServerConfig) {
  return {
    serverUrl: String(config.url),
    accessToken: config.accessToken,
    customHeaders: config.requestInit?.headers as
      | Record<string, string>
      | undefined,
  };
}

function handleUnsupportedTransport(
  c: any,
  error: unknown,
): Response | undefined {
  if (error instanceof UnsupportedTransportError) {
    return c.json(
      { success: false, error: error.message, code: error.code },
      400,
    );
  }
  return undefined;
}

// ── POST /protocol ──────────────────────────────────────────────────────

const protocolSchema = z.object({
  serverId: z.string().min(1),
  /** Pin the run to one protocol version; absent ⇒ adopt the negotiated one. */
  protocolVersion: z.enum(MCP_PROTOCOL_VERSIONS).optional(),
});

conformance.post("/protocol", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = protocolSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const resolved = resolveServerConfig(c.mcpClientManager, parsed.data.serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    assertHttpSupported("protocol", resolved.config);
    const { result } = await runProtocolConformance({
      ...toHttpResolved(resolved.config as HttpServerConfig),
      protocolVersion: parsed.data.protocolVersion,
    });
    return c.json({ success: true, result });
  } catch (error) {
    const unsupported = handleUnsupportedTransport(c, error);
    if (unsupported) return unsupported;
    reportRouteFailure("[Conformance Protocol]", error, {
      // Conformance probes EXIST to make a user's server misbehave. Paging
      // on that would be paging on the feature working.
      source: "mcp.conformance.protocol",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /apps ──────────────────────────────────────────────────────────

const appsSchema = z.object({
  serverId: z.string().min(1),
});

conformance.post("/apps", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = appsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const resolved = resolveServerConfig(c.mcpClientManager, parsed.data.serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    // MCPClientManager stores `url` as a URL object; the SDK expects a string.
    const serverConfig = { ...resolved.config } as MCPServerConfig;
    if ("url" in serverConfig && serverConfig.url) {
      (serverConfig as any).url = String(serverConfig.url);
    }

    const { result } = await runAppsConformance(serverConfig);
    return c.json({ success: true, result });
  } catch (error) {
    reportRouteFailure("[Conformance Apps]", error, {
      // Conformance probes EXIST to make a user's server misbehave. Paging
      // on that would be paging on the feature working.
      source: "mcp.conformance.apps",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /tasks ─────────────────────────────────────────────────────────

const tasksSchema = z.object({
  serverId: z.string().min(1),
  /** Tool used to provoke a task; required on the extension wire, where tools
   *  carry no task metadata to pick from. */
  toolName: z.string().min(1).optional(),
  toolArguments: z.record(z.string(), z.unknown()).optional(),
  pollTimeoutMs: z.number().int().positive().max(120_000).optional(),
});

conformance.post("/tasks", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = tasksSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { serverId, ...runOptions } = parsed.data;
    const resolved = resolveServerConfig(c.mcpClientManager, serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    // MCPClientManager stores `url` as a URL object; the SDK expects a string.
    const serverConfig = { ...resolved.config } as MCPServerConfig;
    if ("url" in serverConfig && serverConfig.url) {
      (serverConfig as any).url = String(serverConfig.url);
    }

    const { result } = await runTasksConformance({
      ...serverConfig,
      ...runOptions,
    });
    return c.json({ success: true, result });
  } catch (error) {
    reportRouteFailure("[Conformance Tasks]", error, {
      // Conformance probes EXIST to make a user's server misbehave. Paging
      // on that would be paging on the feature working.
      source: "mcp.conformance.tasks",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z.object({
  serverId: z.string().min(1),
  oauthProfile: oauthConformanceProfileSchema.optional(),
  callbackOrigin: z.string().optional(),
});

conformance.post("/oauth/start", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = oauthStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const { serverId, oauthProfile, callbackOrigin } = parsed.data;
    const resolved = resolveServerConfig(c.mcpClientManager, serverId);
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    assertHttpSupported("oauth", resolved.config);
    const http = toHttpResolved(resolved.config as HttpServerConfig);

    if (!callbackOrigin) {
      return c.json(
        {
          success: false,
          error:
            "callbackOrigin is required to run OAuth conformance (browser redirect target)",
          code: "missingCallbackOrigin",
        },
        400,
      );
    }

    const result = await startOAuthConformance({
      defaultServerUrl: http.serverUrl,
      defaultCustomHeaders: http.customHeaders,
      redirectUrl: `${callbackOrigin.replace(/\/$/, "")}/oauth/callback/debug`,
      oauthProfile,
    });
    return c.json(result);
  } catch (error) {
    const unsupported = handleUnsupportedTransport(c, error);
    if (unsupported) return unsupported;
    reportRouteFailure("[Conformance OAuth Start]", error, {
      // Conformance probes EXIST to make a user's server misbehave. Paging
      // on that would be paging on the feature working.
      source: "mcp.conformance.oauth.start",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/authorize ───────────────────────────────────────────────

const oauthAuthorizeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

conformance.post("/oauth/authorize", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = oauthAuthorizeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const delivered = submitOAuthConformanceCode(parsed.data);
    if (!delivered) {
      return c.json(
        {
          success: false,
          error: "Session not found or not waiting for authorization",
        },
        404,
      );
    }
    return c.json({ success: true });
  } catch (error) {
    reportRouteFailure("[Conformance OAuth Authorize]", error, {
      // Unlike its siblings, this handler contacts nothing: it parses the
      // request and hands the code to a local conformance session. A failure
      // is our session bookkeeping.
      source: "mcp.conformance.oauth.authorize",
      hop: "mcpjam_internal",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /oauth/complete ────────────────────────────────────────────────

const oauthCompleteSchema = z.object({
  sessionId: z.string().min(1),
});

conformance.post("/oauth/complete", async (c) => {
  try {
    const body = await readRequestJson(c);
    const parsed = oauthCompleteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        400,
      );
    }

    const result = await completeOAuthConformance(parsed.data);
    return c.json(result);
  } catch (error) {
    if (error instanceof OAuthConformanceSessionNotFoundError) {
      return c.json({ success: false, error: error.message }, 404);
    }
    if (error instanceof OAuthConformanceSessionFailedError) {
      return c.json({ success: false, error: error.message }, 500);
    }
    reportRouteFailure("[Conformance OAuth Complete]", error, {
      // Conformance probes EXIST to make a user's server misbehave. Paging
      // on that would be paging on the feature working.
      source: "mcp.conformance.oauth.complete",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// ── POST /readiness/:publisher ──────────────────────────────────────────

/**
 * The LOCAL, deterministic, free readiness grade.
 *
 * `includeLlmObservations` is deliberately absent from this schema rather than
 * accepted and refused. Model observations need a lease, a payer and a broker,
 * none of which a local run has — so the honest surface is one that cannot ask
 * for them, and a caller that wants them uses the hosted start endpoint. A
 * flag here would suggest the capability exists on this path and is merely
 * switched off.
 */
const readinessSchema = z.object({
  serverId: z.string().min(1),
  /**
   * The DECLARED submission shape, required for OpenAI.
   *
   * Never inferred: inference reads a forgotten package as "MCP-only", which
   * reports the package lane `not-applicable` — a missing input becoming a
   * clean bill of health.
   */
  submissionMode: z
    .enum([
      "skills-only",
      "mcp-only",
      "mcp-imported-skills",
      "mcp-uploaded-skills",
    ])
    .optional(),
});

conformance.post("/readiness/:publisher", async (c) => {
  const publisher = c.req.param("publisher");
  if (publisher !== "claude" && publisher !== "openai") {
    return c.json(
      { success: false, error: "publisher must be claude or openai" },
      400,
    );
  }

  try {
    const body = await readRequestJson(c);
    const parsed = readinessSchema.safeParse(body);
    if (!parsed.success) {
      // One stable code for every shape rejection, so a caller can branch on
      // "my request was malformed" without parsing the human sentence. The
      // sentence names WHICH field; the code says only that the body lost at
      // the door, before any server was resolved or dialled.
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
          code: "invalidRequest",
        },
        400,
      );
    }
    if (publisher === "openai" && !parsed.data.submissionMode) {
      return c.json(
        {
          success: false,
          error:
            "An OpenAI readiness run must declare its submission mode; it is never inferred from the inputs supplied.",
          code: "submissionModeRequired",
        },
        400,
      );
    }

    const resolved = resolveServerConfig(
      c.mcpClientManager,
      parsed.data.serverId,
    );
    if ("error" in resolved) {
      return c.json({ success: false, ...resolved }, 400);
    }

    const support = canRunConformance("protocol", resolved.config);
    if (!support.supported) {
      // Readiness grades what a HOST would see, and every host in question
      // reaches a server over HTTP. A stdio server is not a connector these
      // directories can list, so this is a wrong-shape refusal rather than a
      // gap in the run.
      return c.json(
        {
          success: false,
          error:
            support.reason ??
            "Directory readiness grades HTTP connectors; this server uses a different transport.",
          code: "unsupportedTransport",
        },
        400,
      );
    }

    const http = toHttpResolved(resolved.config as HttpServerConfig);
    const { result } = await runLocalDirectoryReadiness({
      publisher,
      target: http.serverUrl,
      submissionMode: parsed.data.submissionMode,
      accessToken: http.accessToken,
      customHeaders: http.customHeaders,
    });
    return c.json({ success: true, result });
  } catch (error) {
    reportRouteFailure("[Conformance Readiness]", error, {
      // Readiness probes EXIST to find problems on a user's server. Paging on
      // that would be paging on the feature working.
      source: "mcp.conformance.readiness",
      hop: "user_server_hop",
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default conformance;
