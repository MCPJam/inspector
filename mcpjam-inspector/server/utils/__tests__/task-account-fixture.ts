import type { MCPClientManager } from "@mcpjam/sdk";
import { setManagerConnections } from "../mcp-connections.js";

export const TASK_ACCOUNT_KEY = "s1::account-b";

export function installTaskAccounts(manager: MCPClientManager): void {
  setManagerConnections(manager, {
    s1: [
      {
        serverId: "s1",
        connectionId: "account-a",
        key: "s1",
        label: "A",
        isDefault: true,
      },
      {
        serverId: "s1",
        connectionId: "account-b",
        key: TASK_ACCOUNT_KEY,
        label: "B",
        isDefault: false,
      },
    ],
  });
}
