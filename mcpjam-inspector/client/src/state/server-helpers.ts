import { MCPServerConfig } from "@mcpjam/sdk";
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

  const httpConfig: HttpServerDefinition = {
    ...baseConfig,
    url: new URL(formData.url!),
    requestInit: { headers: formData.headers || {} },
  };

  // Only store OAuth-related fields when actually using OAuth
  // This prevents the form from thinking OAuth is enabled when it's not
  if (formData.useOAuth) {
    if (formData.oauthScopes && formData.oauthScopes.length > 0) {
      httpConfig.oauthScopes = formData.oauthScopes;
    }

    if (formData.clientId) {
      httpConfig.clientId = formData.clientId;
    }

    if (formData.clientSecret) {
      httpConfig.clientSecret = formData.clientSecret;
    }
  }

  return httpConfig;
}
