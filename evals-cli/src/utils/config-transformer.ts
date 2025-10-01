interface MCPServerConfig {
  type?: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPServersConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface EvalsServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  requestInit?: {
    headers?: Record<string, string>;
  };
}

interface EvalsEnvironmentConfig {
  servers: Record<string, EvalsServerConfig>;
}

export function transformMCPServersConfig(
  config: MCPServersConfig,
): EvalsEnvironmentConfig {
  const evalsServers: Record<string, EvalsServerConfig> = {};

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig || typeof serverConfig !== "object") {
      console.warn(`Skipping invalid server config for "${serverName}"`);
      continue;
    }

    const evalsConfig: EvalsServerConfig = {};

    // Handle HTTP/SSE servers
    if (serverConfig.url) {
      evalsConfig.url = serverConfig.url;

      // Transform headers
      if (
        serverConfig.headers &&
        Object.keys(serverConfig.headers).length > 0
      ) {
        evalsConfig.requestInit = {
          headers: serverConfig.headers,
        };
      }
    }
    // Handle STDIO servers
    else if (serverConfig.command) {
      evalsConfig.command = serverConfig.command;

      if (serverConfig.args && serverConfig.args.length > 0) {
        evalsConfig.args = serverConfig.args;
      }

      if (serverConfig.env && Object.keys(serverConfig.env).length > 0) {
        evalsConfig.env = serverConfig.env;
      }
    } else {
      console.warn(
        `Skipping server "${serverName}": missing both url and command`,
      );
      continue;
    }

    evalsServers[serverName] = evalsConfig;
  }

  return { servers: evalsServers };
}

/**
 * Detects if a config is in Claude/Cursor format vs evals format
 */
export function detectConfigFormat(
  config: unknown,
): "claude-cursor" | "evals" | "unknown" {
  if (!config || typeof config !== "object") {
    return "unknown";
  }

  const obj = config as Record<string, unknown>;

  // Evals format has "servers" key
  if (obj.servers && typeof obj.servers === "object") {
    return "evals";
  }

  // Claude/Cursor format has "mcpServers" key
  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    return "claude-cursor";
  }

  return "unknown";
}

export function parseAndTransformConfig(
  jsonContent: string,
): EvalsEnvironmentConfig {
  const parsed = JSON.parse(jsonContent);
  const format = detectConfigFormat(parsed);

  switch (format) {
    case "evals":
      return parsed as EvalsEnvironmentConfig;
    case "claude-cursor":
      return transformMCPServersConfig(parsed as MCPServersConfig);
    case "unknown":
      throw new Error(
        'Invalid config format. Expected either { "servers": {...} } or { "mcpServers": {...} }',
      );
  }
}
