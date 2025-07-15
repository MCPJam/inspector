// server/src/testing/HealthCheck.ts
import { MCPProxyService } from "../shared/MCPProxyService.js";
import { DatabaseManager } from "../database/DatabaseManager.js";
import { Logger } from "../shared/types.js";

export class HealthCheck {
  constructor(
    private mcpProxyService: MCPProxyService,
    private database: DatabaseManager,
    private logger: Logger,
  ) {}

  getStatus(): {
    testing: boolean;
    status: string;
    version: string;
    timestamp: string;
  } {
    return {
      testing: true,
      status: "healthy",
      version: process.env.npm_package_version || "0.3.5",
      timestamp: new Date().toISOString(),
    };
  }

  getDetailedStatus(): {
    testing: boolean;
    server: {
      status: string;
      uptime: number;
      memory: NodeJS.MemoryUsage;
      version: string;
    };
    connections: {
      active: number;
      list: string[];
    };
    database: {
      connected: boolean;
      status: string;
    };
    timestamp: string;
  } {
    return {
      testing: true,
      server: {
        status: "running",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.env.npm_package_version || "0.3.5",
      },
      connections: {
        active: this.mcpProxyService.getActiveConnections().length,
        list: this.mcpProxyService.getActiveConnections(),
      },
      database: {
        connected: this.isDatabaseConnected(),
        status: this.isDatabaseConnected() ? "connected" : "disconnected",
      },
      timestamp: new Date().toISOString(),
    };
  }

  private isDatabaseConnected(): boolean {
    // Simple check - in a real implementation you might want to ping the database
    return this.database !== null && this.database !== undefined;
  }
}
