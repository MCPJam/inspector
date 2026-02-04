import type { MCPClientManager } from "@mcpjam/sdk";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpClientManager: MCPClientManager;
  }
}
