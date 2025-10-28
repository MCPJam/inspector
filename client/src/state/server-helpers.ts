import { MCPServerConfig } from "@/sdk";
import {
  HttpServerDefinition,
  StdioServerDefinition,
  ServerFormData,
} from "@/shared/types.js";

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
    } as StdioServerDefinition;
  }
  return {
    ...baseConfig,
    url: new URL(formData.url!),
    requestInit: { headers: formData.headers || {} },
  } as HttpServerDefinition;
}
