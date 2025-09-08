import { MastraMCPServerDefinition } from "@mastra/mcp";
import {
  HttpServerDefinition,
  StdioServerDefinition,
  ServerFormData,
} from "@/shared/types.js";

export function toMCPConfig(
  formData: ServerFormData,
): MastraMCPServerDefinition {
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
