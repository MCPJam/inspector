import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../utils/logger.js";

/**
 * Wait for the connect a freshly built manager queued, before the bridge
 * answers from the live connection (see `JsonRpcBridgeOptions.awaitConnect`).
 * A connect that fails answers as before: the stand-in `initialize`, or
 * method-not-found from the passthrough, and the next call that needs the
 * server reports why.
 */
export async function awaitBridgeConnect(
  manager: MCPClientManager,
  serverId: string,
  method: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await manager.ensureManagedClient(
      serverId,
      signal ? { signal } : undefined,
    );
  } catch (error) {
    logger.debug("[mcp-bridge] connect did not finish before the answer", {
      serverId,
      method,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
