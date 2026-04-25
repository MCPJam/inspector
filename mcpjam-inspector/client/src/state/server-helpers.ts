import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ServerFormData } from "@/shared/types.js";

export function toMCPConfig(formData: ServerFormData): MCPServerConfig {
  const baseConfig = {
    timeout: formData.requestTimeout,
    clientCapabilities: formData.clientCapabilities,
  };

  if (formData.type === "stdio") {
    return {
      ...baseConfig,
      command: formData.command!,
      args: formData.args,
      env: formData.env,
    };
  }

  const httpConfig: HttpServerConfig = {
    ...baseConfig,
    url: formData.url!,
    ...(formData.headers
      ? {
          requestInit: { headers: formData.headers },
        }
      : {}),
  };

  return httpConfig;
}
