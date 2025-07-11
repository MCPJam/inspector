import {
  MCPJamServerConfig,
  StdioServerDefinition,
  HttpServerDefinition,
} from "../../types/serverTypes";

// Display string representations
export interface ConfigDisplayStrings {
  argsString: string;
  urlString: string;
}

// Extract display strings from config
export function configToDisplayStrings(
  config: MCPJamServerConfig,
): ConfigDisplayStrings {
  const argsString =
    config.transportType === "stdio" && "args" in config
      ? config.args?.join(" ") || ""
      : "";

  const urlString =
    config.transportType !== "stdio" && "url" in config
      ? config.url?.toString() || ""
      : "";

  return { argsString, urlString };
}

// Type-safe config builders
export function createStdioConfig(
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
): StdioServerDefinition {
  return {
    transportType: "stdio",
    command,
    args,
    env,
  };
}

export function createHttpConfig(
  url: URL,
  transportType: "sse" | "streamable-http" = "sse",
): HttpServerDefinition {
  return {
    transportType,
    url,
  };
}

// Update config from string inputs
export function updateConfigFromStrings(
  config: MCPJamServerConfig,
  argsString: string,
): MCPJamServerConfig {
  if (config.transportType === "stdio") {
    return {
      ...config,
      args: argsString.trim() ? argsString.split(/\s+/) : [],
    } as StdioServerDefinition;
  } else {
    // For HTTP configs, we'll validate the URL when building the final config
    return config;
  }
}

// Validate and build final config with URL parsing
export function validateAndBuildConfig(
  config: MCPJamServerConfig,
  argsString: string,
  urlString: string,
): { config: MCPJamServerConfig; error?: string } {
  if (config.transportType === "stdio") {
    const updatedConfig = {
      ...config,
      args: argsString.trim() ? argsString.split(/\s+/) : [],
    } as StdioServerDefinition;

    return { config: updatedConfig };
  } else {
    try {
      const url = new URL(urlString);
      const updatedConfig = {
        ...config,
        url,
      } as HttpServerDefinition;

      return { config: updatedConfig };
    } catch {
      return {
        config,
        error: "Invalid URL format",
      };
    }
  }
}

// Create default configs
export function createDefaultStdioConfig(): StdioServerDefinition {
  return createStdioConfig("npx", ["@modelcontextprotocol/server-everything"]);
}

export function createDefaultHttpConfig(
  transportType: "sse" | "streamable-http" = "sse",
): HttpServerDefinition {
  return createHttpConfig(new URL("https://example.com"), transportType);
}

// Check if config is stdio
export function isStdioConfig(
  config: MCPJamServerConfig,
): config is StdioServerDefinition {
  return config.transportType === "stdio";
}

// Check if config is HTTP
export function isHttpConfig(
  config: MCPJamServerConfig,
): config is HttpServerDefinition {
  return config.transportType !== "stdio";
}
