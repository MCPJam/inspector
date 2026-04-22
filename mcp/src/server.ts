import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { JWTPayload } from "jose";
import { createSessionToolRegistrar } from "./tools/sessionToolRegistrar.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerGetOrgTool } from "./tools/getOrg.js";
import { registerGetWorkspacesTool } from "./tools/getWorkspaces.js";
import { registerWhoamiTool } from "./tools/whoami.js";

const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

interface McpProps extends Record<string, unknown> {
  bearerToken: string;
  claims: JWTPayload;
}

export class McpJamMcpServer extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "MCPJam MCP",
    version: "0.1.0",
  });

  get runtimeEnv(): Required<Env> {
    return this.env as Required<Env>;
  }

  get bearerToken(): string | undefined {
    return this.props?.bearerToken;
  }

  async init(): Promise<void> {
    const registrar = createSessionToolRegistrar(this.server);
    let initialized = false;

    registerWhoamiTool(registrar, this);
    registerDoctorTool(registrar, this);
    registerGetWorkspacesTool(registrar, this);
    registerGetOrgTool(registrar, this);

    this.server.server.oninitialized = () => {
      if (initialized) {
        return;
      }

      initialized = true;

      const clientCapabilities = this.server.server.getClientCapabilities();
      const uiCapability = getUiCapability(clientCapabilities);
      const uiEnabled =
        uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;

      registrar.setUiEnabled(uiEnabled);
    };
  }
}

function getUiCapability(
  clientCapabilities: ClientCapabilities | undefined
): { mimeTypes?: string[] } | undefined {
  const extensions = (clientCapabilities as
    | (ClientCapabilities & { extensions?: Record<string, unknown> })
    | undefined)?.extensions;

  return extensions?.[UI_EXTENSION_ID] as { mimeTypes?: string[] } | undefined;
}
