import { randomUUID } from "crypto";
import { ServerConfig, Logger } from "./types.js";

export function generateSessionId(): string {
  return randomUUID();
}

export function validateServerConfig(config: ServerConfig): void {
  if (!config.id || !config.type || !config.name) {
    throw new Error(
      "Invalid server configuration: id, type, and name are required",
    );
  }

  if (config.type === "stdio" && !config.command) {
    throw new Error("STDIO transport requires command");
  }

  if (
    (config.type === "sse" || config.type === "streamable-http") &&
    !config.url
  ) {
    throw new Error("SSE and StreamableHTTP transports require URL");
  }
}

export class ConsoleLogger implements Logger {
  info(message: string, ...args: any[]): void {
    console.log(`[INFO] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[WARN] ${message}`, ...args);
  }
}
