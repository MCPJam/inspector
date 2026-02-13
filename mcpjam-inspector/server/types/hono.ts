import type { MCPClientManager } from "@mcpjam/sdk";
import type { TenantRuntimeActor } from "../services/runtime/tenant-actor-registry";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpClientManager: MCPClientManager;
    runtimeActor?: TenantRuntimeActor;
    tenantId?: string;
  }
}
