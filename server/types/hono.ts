import { MCPJamAgent } from "../services/mcpjam-agent";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    get<K extends "mcpAgent">(key: K): K extends "mcpAgent" ? MCPJamAgent : never;
    set<K extends "mcpAgent">(key: K, value: K extends "mcpAgent" ? MCPJamAgent : never): void;
  }
}