import { MCPJamClientManager } from "../services/mcpjam-client-manager";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    get<K extends "mcpJamClientManager">(
      key: K,
    ): K extends "mcpJamClientManager" ? MCPJamClientManager : never;
    set<K extends "mcpJamClientManager">(
      key: K,
      value: K extends "mcpJamClientManager" ? MCPJamClientManager : never,
    ): void;
  }
}
