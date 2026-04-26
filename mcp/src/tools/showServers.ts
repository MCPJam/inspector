import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { SHOW_SERVERS_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import type { ShowServersPayload } from "../shared/show-servers.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";
import {
  buildShowServersPayload,
  resolveWorkspace,
  type RemoteServer,
  type RemoteWorkspace,
} from "./showServersCore.js";

export const SHOW_SERVERS_RESOURCE_URI = "ui://mcpjam/show-servers.html";

export function registerShowServersTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registrar.registerTool(
    "show_servers",
    {
      title: "Show MCPJam servers",
      description:
        "Show all MCP servers in a workspace with their health status. If no workspace is specified, shows the most recently updated accessible workspace and returns other workspace names for switching.",
      inputSchema: z.object({
        workspace: z.string().min(1).optional(),
      }),
    },
    async ({ workspace }) => getShowServersToolResult(agent, workspace),
    {
      resourceUri: SHOW_SERVERS_RESOURCE_URI,
      html: SHOW_SERVERS_APP_HTML,
      resourceName: "MCPJam show servers UI",
      resourceMeta: {
        ui: {
          prefersBorder: true,
        },
      },
      callback: async ({ workspace }) =>
        getShowServersToolResult(agent, workspace),
    }
  );
}

export async function getShowServersToolResult(
  agent: McpJamMcpServer,
  workspaceSelector?: string
) {
  const token = agent.bearerToken;
  if (!token) {
    return toolError("No bearer token on the request.");
  }

  const convex = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
  convex.setAuth(token);

  let workspaces: RemoteWorkspace[];
  try {
    workspaces = (await convex.query(
      "workspaces:getMyWorkspaces" as any,
      {}
    )) as RemoteWorkspace[];
  } catch (error) {
    return toolError(`Failed to load workspaces: ${parseErrorMessage(error)}`);
  }

  const resolution = resolveWorkspace(workspaces, workspaceSelector);
  if (!resolution.ok) {
    return toolError(resolution.message);
  }

  let servers: RemoteServer[];
  try {
    servers = (await convex.query("servers:getWorkspaceServers" as any, {
      workspaceId: resolution.workspace._id,
    })) as RemoteServer[];
  } catch (error) {
    return toolError(`Failed to load servers: ${parseErrorMessage(error)}`);
  }

  const payload = await buildShowServersPayload({
    bearerToken: token,
    convexHttpUrl: agent.runtimeEnv.CONVEX_HTTP_URL,
    workspace: resolution.workspace,
    workspaces: resolution.sortedWorkspaces,
    servers,
    generatedAt: new Date().toISOString(),
  });

  return toolSuccess(payload);
}

function toolSuccess(payload: ShowServersPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
