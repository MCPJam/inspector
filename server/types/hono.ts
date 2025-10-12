import type { MCPClientManager } from "@/shared/mcp-client-manager";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpClientManager: MCPClientManager;
  }
}
