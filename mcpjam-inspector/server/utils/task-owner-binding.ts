import type { MCPClientManager } from "@mcpjam/sdk";
import { progressStore } from "../services/progress-store.js";
import {
  getManagerTaskOwnerScope,
  setManagerTaskOwnerScope,
} from "./mcp-connections.js";

/** A reused local key must not expose the previous owner's cached progress. */
export function bindLocalTaskOwnerScope(
  manager: MCPClientManager,
  keys: string[],
  scope: string | undefined,
): void {
  for (const key of keys) {
    if (getManagerTaskOwnerScope(manager, key) !== scope)
      progressStore.clearAllProgress(key);
  }
  setManagerTaskOwnerScope(manager, keys, scope);
}
