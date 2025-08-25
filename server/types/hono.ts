import { MCPJamClientManager } from "../services/mcpjam-client-manager";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpJamClientManager: MCPJamClientManager;
  }
}
