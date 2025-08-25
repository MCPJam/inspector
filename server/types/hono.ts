import { MCPJamClientManager } from "../services/mcpjam-client-manager";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    get<K extends "mcpAgent">(
      key: K,
    ): K extends "mcpAgent" ? MCPJamClientManager : never;
    set<K extends "mcpAgent">(
      key: K,
      value: K extends "mcpAgent" ? MCPJamClientManager : never,
    ): void;
  }
}
