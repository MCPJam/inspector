import { MCPJamClientManager } from "../../../server/services/mcpjam-client-manager.js";
import { ServerConnectionError } from "./test-errors.js";
import { Logger } from "./logger.js";

export class TestConnectionManager {
  private clientManager: MCPJamClientManager;
  private connectedServers = new Set<string>();

  constructor() {
    this.clientManager = new MCPJamClientManager();
  }

  async connectToServers(serverConfigs: Record<string, any>): Promise<void> {
    const connectionPromises = Object.entries(serverConfigs).map(
      async ([name, config]) => {
        if (!this.connectedServers.has(name)) {
          try {
            await this.clientManager.connectToServer(name, config);
            this.connectedServers.add(name);
          } catch (error) {
            throw new ServerConnectionError(
              name,
              (error as Error)?.message || "Unknown connection error",
            );
          }
        }
      },
    );

    await Promise.all(connectionPromises);

    Logger.serverConnection(
      Object.keys(serverConfigs).length,
      this.clientManager.getAvailableTools().length,
    );
  }

  getAvailableTools() {
    return this.clientManager.getAvailableTools();
  }

  getFlattenedTools(): Record<string, any> {
    const allTools = this.getAvailableTools();
    const flattenedTools: Record<string, any> = {};

    for (const tool of allTools) {
      flattenedTools[tool.name] = tool;
    }

    return flattenedTools;
  }

  async cleanup(): Promise<void> {
    try {
      for (const serverName of this.connectedServers) {
        await this.clientManager.disconnectFromServer(serverName);
      }
      this.connectedServers.clear();
    } catch (error) {
      throw new Error(
        `Cleanup failed: ${(error as Error)?.message || "Unknown error"}`,
      );
    }
  }

  isConnected(serverName: string): boolean {
    return this.connectedServers.has(serverName);
  }

  getConnectedServers(): string[] {
    return Array.from(this.connectedServers);
  }
}
