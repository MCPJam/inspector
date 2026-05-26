import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { SHOW_SERVERS_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import type { ShowServersPayload } from "../shared/show-servers.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";
import {
  buildShowServersPayload,
  resolveProject,
  type RemoteServer,
  type RemoteProject,
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
        "Show all MCP servers in a project with their health status. If no project is specified, shows the most recently updated accessible project and returns other project names for switching.",
      inputSchema: z.object({
        project: z.string().min(1).optional(),
      }),
    },
    async ({ project }) => getShowServersToolResult(agent, project),
    {
      resourceUri: SHOW_SERVERS_RESOURCE_URI,
      html: SHOW_SERVERS_APP_HTML,
      resourceName: "MCPJam show servers UI",
      resourceMeta: {
        ui: {
          prefersBorder: true,
        },
      },
      callback: async ({ project }) =>
        getShowServersToolResult(agent, project),
    }
  );
}

export async function getShowServersToolResult(
  agent: McpJamMcpServer,
  projectSelector?: string
) {
  const token = agent.bearerToken;
  if (!token) {
    return toolError("No bearer token on the request.");
  }

  const convex = new ConvexHttpClient(agent.runtimeEnv.CONVEX_URL);
  convex.setAuth(token);

  let projects: RemoteProject[];
  try {
    projects = (await convex.query(
      "projects:getMyProjects" as any,
      {}
    )) as RemoteProject[];
  } catch (error) {
    return toolError(`Failed to load projects: ${parseErrorMessage(error)}`);
  }

  const resolution = resolveProject(projects, projectSelector);
  if (!resolution.ok) {
    return toolError(resolution.message);
  }

  let servers: RemoteServer[];
  try {
    servers = (await convex.query("servers:getProjectServers" as any, {
      projectId: resolution.project._id,
    })) as RemoteServer[];
  } catch (error) {
    return toolError(`Failed to load servers: ${parseErrorMessage(error)}`);
  }

  const payload = await buildShowServersPayload({
    bearerToken: token,
    convexHttpUrl: agent.runtimeEnv.CONVEX_HTTP_URL,
    project: resolution.project,
    projects: resolution.sortedProjects,
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
