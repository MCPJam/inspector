import { MCPServerConfig } from "@/shared/mcp-client-manager";
import {
  HttpServerDefinition,
  StdioServerDefinition,
  ServerFormData,
} from "@/shared/types.js";

export function toMCPConfig(formData: ServerFormData): MCPServerConfig {
  if (formData.type === "stdio") {
    return {
      command: formData.command!,
      args: formData.args,
      env: formData.env,
    } as StdioServerDefinition;
  }
  return {
    url: new URL(formData.url!),
    requestInit: { headers: formData.headers || {} },
  } as HttpServerDefinition;
}
