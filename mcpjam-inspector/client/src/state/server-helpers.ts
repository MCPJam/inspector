import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk";
import type { ServerFormData } from "@/shared/types.js";

export function toMCPConfig(formData: ServerFormData): MCPServerConfig {
  const baseConfig = {
    timeout: formData.requestTimeout,
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
    requestInit: { headers: formData.headers || {} },
  };

  return httpConfig;
}
