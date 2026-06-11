/**
 * The widget-backed `show_servers` tool: same catalog operation as the plain
 * tools, plus an MCP Apps UI resource rendered when the client supports it.
 */
import { showServersOperation } from "@mcpjam/sdk/platform";
import { SHOW_SERVERS_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import type { McpJamMcpServer } from "../server.js";
import {
  operationAnnotations,
  runPlatformOperation,
} from "./platformTools.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

export const SHOW_SERVERS_RESOURCE_URI = "ui://mcpjam/show-servers.html";

export function registerShowServersTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registrar.registerTool(
    showServersOperation.name,
    {
      title: showServersOperation.title,
      description: showServersOperation.description,
      inputSchema: showServersOperation.inputSchema,
      annotations: operationAnnotations(showServersOperation),
    },
    async (input) => runPlatformOperation(agent, showServersOperation, input),
    {
      resourceUri: SHOW_SERVERS_RESOURCE_URI,
      html: SHOW_SERVERS_APP_HTML,
      resourceName: "MCPJam show servers UI",
      resourceMeta: {
        ui: {
          prefersBorder: true,
        },
      },
      callback: async (input) =>
        runPlatformOperation(agent, showServersOperation, input),
    }
  );
}
