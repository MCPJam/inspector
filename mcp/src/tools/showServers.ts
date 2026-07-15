/**
 * The widget-backed `show_servers` tool: same catalog operation as the plain
 * tools, plus the shared MCP Apps bundle rendered when the client supports
 * it. Registered separately from the catalog loop because the operation
 * lives outside `PLATFORM_CATALOG_OPERATIONS` (it supersedes
 * list_project_servers for widget-capable hosts).
 */
import { showServersOperation } from "@mcpjam/sdk/platform";
import { PLATFORM_WIDGET_RESOURCE_URIS } from "../shared/platform-widgets.js";
import type { McpJamMcpServer } from "../server.js";
import {
  operationAnnotations,
  platformWidgetUi,
  runPlatformOperation,
} from "./platformTools.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

export const SHOW_SERVERS_RESOURCE_URI = PLATFORM_WIDGET_RESOURCE_URIS.servers;

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
    platformWidgetUi(agent, showServersOperation, "servers")
  );
}
