import { createServer } from "http";

export function findAvailablePort(startPort = 3500): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as any)?.port;
      server.close(() => {
        resolve(port || startPort);
      });
    });
    server.on("error", () => {
      resolve(startPort);
    });
  });
}

import {
  MCPJamClientManager,
  DiscoveredTool,
} from "../../../server/services/mcpjam-client-manager.js";
import { ServerConnectionError } from "./test-errors.js";
import { Logger } from "./logger.js";

export function createFlattenedTools(
  tools: DiscoveredTool[],
): Record<string, any> {
  const flattenedTools: Record<string, any> = {};
  for (const tool of tools) {
    flattenedTools[tool.name] = tool;
  }
  return flattenedTools;
}

export async function connectToServersWithLogging(
  clientManager: MCPJamClientManager,
  serverConfigs: Record<string, any>,
): Promise<void> {
  const connectionPromises = Object.entries(serverConfigs).map(
    async ([name, config]) => {
      try {
        await clientManager.connectToServer(name, config);
      } catch (error) {
        throw new ServerConnectionError(
          name,
          (error as Error)?.message || "Unknown connection error",
        );
      }
    },
  );

  await Promise.all(connectionPromises);

  Logger.serverConnection(
    Object.keys(serverConfigs).length,
    clientManager.getAvailableTools().length,
  );
}

export async function cleanupConnections(
  clientManager: MCPJamClientManager,
  connectedServers: Set<string>,
): Promise<void> {
  try {
    for (const serverName of connectedServers) {
      await clientManager.disconnectFromServer(serverName);
    }
    connectedServers.clear();
  } catch (error) {
    throw new Error(
      `Cleanup failed: ${(error as Error)?.message || "Unknown error"}`,
    );
  }
}
