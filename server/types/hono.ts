import type { MCPClientManager } from "@/sdk";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpClientManager: MCPClientManager;
  }
}
