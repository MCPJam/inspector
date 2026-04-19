import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JWTPayload } from "jose";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerGetOrgTool } from "./tools/getOrg.js";
import { registerGetWorkspacesTool } from "./tools/getWorkspaces.js";
import { registerWhoamiTool } from "./tools/whoami.js";

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
    registerWhoamiTool(this.server, this);
    registerDoctorTool(this.server, this);
    registerGetWorkspacesTool(this.server, this);
    registerGetOrgTool(this.server, this);
  }
}
