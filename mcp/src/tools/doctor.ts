import { ConvexHttpClient } from "convex/browser";
import {
  redactSensitiveValue,
  runHttpServerDoctor,
  type HttpServerConfig,
  type ServerDoctorResult,
} from "@mcpjam/sdk/worker";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpJamMcpServer } from "../server.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const STDIO_SKIP_REASON =
  "stdio transport not supported by hosted MCPJam MCP; run doctor locally via @mcpjam/cli-preview";
const HOSTED_HTTP_SKIP_REASON =
  "hosted MCPJam MCP only supports HTTPS HTTP servers; run doctor locally via @mcpjam/cli-preview";

type RemoteWorkspace = {
  _id: string;
  organizationId: string;
  name: string;
};

type RemoteServer = {
  _id: string;
  name: string;
  transportType: "http" | "stdio";
  url?: string;
};

type AuthorizeSuccessResponse = {
  authorized: true;
  oauthAccessToken?: string;
  serverConfig: {
    transportType: "http" | "stdio";
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
};

type AuthorizeFailureResponse = {
  code?: string;
  message?: string;
};

type DoctorEntry =
  | {
      id: string;
      name: string;
      transportType: "http" | "stdio";
      status: "skipped";
      skippedReason: string;
    }
  | {
      id: string;
      name: string;
      transportType: "http" | "stdio";
      status: "error";
      error: {
        code: string;
        message: string;
      };
    }
  | {
      id: string;
      name: string;
      transportType: "http" | "stdio";
      status: "ready" | "partial" | "oauth_required" | "error";
      doctor: ServerDoctorResult<{
        id: string;
        name: string;
        url: string;
      }>;
    };

export function registerDoctorTool(
  server: McpServer,
  agent: McpJamMcpServer
): void {
  server.registerTool(
    "doctor",
    {
      title: "Doctor MCP servers in a workspace",
      description:
        "Runs MCPJam's hosted doctor against every supported HTTP MCP server in the given organization and workspace. Stdio and non-HTTPS servers are skipped.",
      inputSchema: z.object({
        organizationId: z.string().min(1),
        workspaceId: z.string().min(1),
        serverIds: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
      }),
    },
    async ({ organizationId, workspaceId, serverIds, timeoutMs }) => {
      const token = agent.bearerToken;
      if (!token) {
        return toolError("No bearer token on the request.");
      }

      const env = agent.runtimeEnv;
      if (!env.CONVEX_HTTP_URL) {
        return toolError("Server misconfigured: CONVEX_HTTP_URL is not set.");
      }

      const convex = new ConvexHttpClient(env.CONVEX_URL);
      convex.setAuth(token);

      let workspaces: RemoteWorkspace[];
      try {
        workspaces = (await convex.query("workspaces:getMyWorkspaces" as any, {
          organizationId,
        })) as RemoteWorkspace[];
      } catch {
        return toolError(
          "Workspace not found in this organization or not accessible."
        );
      }

      const workspace = workspaces.find((entry) => entry._id === workspaceId);
      if (!workspace) {
        return toolError(
          "Workspace not found in this organization or not accessible."
        );
      }

      const allServers = (await convex.query(
        "servers:getWorkspaceServers" as any,
        { workspaceId }
      )) as RemoteServer[];

      const serverById = new Map(allServers.map((entry) => [entry._id, entry]));
      const requestedServerIds =
        serverIds ?? allServers.map((entry) => entry._id);
      const unknownServerIds = requestedServerIds.filter(
        (serverId) => !serverById.has(serverId)
      );
      if (unknownServerIds.length > 0) {
        return toolError(
          `Unknown serverIds for workspace ${workspaceId}: ${unknownServerIds.join(
            ", "
          )}`
        );
      }

      const selectedServers = requestedServerIds.map(
        (serverId) => serverById.get(serverId)!
      );
      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const results: DoctorEntry[] = [];

      for (const serverEntry of selectedServers) {
        if (serverEntry.transportType === "stdio") {
          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: "skipped",
            skippedReason: STDIO_SKIP_REASON,
          });
          continue;
        }

        if (!isSupportedHostedHttpUrl(serverEntry.url)) {
          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: "skipped",
            skippedReason: HOSTED_HTTP_SKIP_REASON,
          });
          continue;
        }

        const authorizeResult = await authorizeServerForHostedDoctor({
          bearerToken: token,
          convexHttpUrl: env.CONVEX_HTTP_URL,
          workspaceId,
          serverId: serverEntry._id,
        });

        if (!authorizeResult.ok) {
          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: "error",
            error: authorizeResult.error,
          });
          continue;
        }

        const doctorUrl = authorizeResult.body.serverConfig.url;
        if (!doctorUrl) {
          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: "error",
            error: {
              code: "INTERNAL_ERROR",
              message: "Authorized server is missing URL.",
            },
          });
          continue;
        }

        try {
          const doctor = await runHttpServerDoctor({
            config: toHostedHttpConfig(
              authorizeResult.body,
              effectiveTimeoutMs
            ),
            target: {
              id: serverEntry._id,
              name: serverEntry.name,
              url: doctorUrl,
            },
            timeout: effectiveTimeoutMs,
          });

          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: doctor.status,
            doctor: redactSensitiveValue(doctor) as ServerDoctorResult<{
              id: string;
              name: string;
              url: string;
            }>,
          });
        } catch (error) {
          results.push({
            id: serverEntry._id,
            name: serverEntry.name,
            transportType: serverEntry.transportType,
            status: "error",
            error: normalizeWorkerError(error),
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                organizationId,
                workspaceId,
                generatedAt: new Date().toISOString(),
                summary: summarizeResults(results),
                servers: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

async function authorizeServerForHostedDoctor(input: {
  bearerToken: string;
  convexHttpUrl: string;
  workspaceId: string;
  serverId: string;
}): Promise<
  | {
      ok: true;
      body: AuthorizeSuccessResponse;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    }
> {
  let response: Response;

  try {
    response = await fetch(`${input.convexHttpUrl}/web/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.bearerToken}`,
      },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        serverId: input.serverId,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SERVER_UNREACHABLE",
        message: `Failed to reach authorization service: ${parseErrorMessage(
          error
        )}`,
      },
    };
  }

  let body: AuthorizeSuccessResponse | AuthorizeFailureResponse | null = null;
  try {
    body = (await response.json()) as
      | AuthorizeSuccessResponse
      | AuthorizeFailureResponse;
  } catch {
    // Ignored. We fall back to a synthetic error payload below.
  }

  if (!response.ok) {
    const failureBody = body && !("authorized" in body) ? body : null;
    return {
      ok: false,
      error: {
        code:
          typeof failureBody?.code === "string"
            ? failureBody.code
            : "INTERNAL_ERROR",
        message:
          typeof failureBody?.message === "string"
            ? failureBody.message
            : `Authorization failed (${response.status}).`,
      },
    };
  }

  if (!body || !("authorized" in body) || body.authorized !== true) {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Authorization denied for server.",
      },
    };
  }

  return { ok: true, body };
}

function toHostedHttpConfig(
  authResponse: AuthorizeSuccessResponse,
  timeoutMs: number
): HttpServerConfig {
  const headers: Record<string, string> = {
    ...(authResponse.serverConfig.headers ?? {}),
  };

  if (authResponse.oauthAccessToken) {
    headers.Authorization = `Bearer ${authResponse.oauthAccessToken}`;
  }

  return {
    url: authResponse.serverConfig.url!,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
  };
}

function isSupportedHostedHttpUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function summarizeResults(results: DoctorEntry[]) {
  return results.reduce(
    (summary, entry) => {
      summary[entry.status] += 1;
      return summary;
    },
    {
      ready: 0,
      partial: 0,
      oauth_required: 0,
      error: 0,
      skipped: 0,
    }
  );
}

function normalizeWorkerError(error: unknown): {
  code: string;
  message: string;
} {
  const message = parseErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }

  if (
    lower.includes("connect") ||
    lower.includes("connection") ||
    lower.includes("refused") ||
    lower.includes("econn")
  ) {
    return { code: "SERVER_UNREACHABLE", message };
  }

  return { code: "INTERNAL_ERROR", message };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
