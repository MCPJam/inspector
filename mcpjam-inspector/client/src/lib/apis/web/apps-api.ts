import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export async function fetchHostedMcpAppWidgetContent(request: {
  serverNameOrId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: "permissive" | "widget-declared";
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/apps/mcp-apps/widget-content", {
    ...serverRequest,
    resourceUri: request.resourceUri,
    toolInput: request.toolInput,
    toolOutput: request.toolOutput,
    toolId: request.toolId,
    toolName: request.toolName,
    theme: request.theme,
    cspMode: request.cspMode,
    template: request.template,
    viewMode: request.viewMode,
    viewParams: request.viewParams,
  });
}

export async function fetchHostedChatGptAppWidgetContent(request: {
  serverNameOrId: string;
  uri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: "permissive" | "widget-declared";
  locale?: string;
  deviceType?: "mobile" | "tablet" | "desktop";
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/apps/chatgpt-apps/widget-content", {
    ...serverRequest,
    uri: request.uri,
    toolInput: request.toolInput,
    toolOutput: request.toolOutput,
    toolResponseMetadata: request.toolResponseMetadata,
    toolId: request.toolId,
    toolName: request.toolName,
    theme: request.theme,
    cspMode: request.cspMode,
    locale: request.locale,
    deviceType: request.deviceType,
  });
}
