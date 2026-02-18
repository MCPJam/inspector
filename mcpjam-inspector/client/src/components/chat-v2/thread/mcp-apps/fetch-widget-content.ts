import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { buildHostedServerRequest } from "@/lib/apis/web/context";
import type { CspMode } from "@/stores/ui-playground-store";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface FetchMcpAppsWidgetContentRequest {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme: string;
  cspMode: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
}

export interface FetchMcpAppsWidgetContentResponse {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  permissive?: boolean;
  mimeTypeWarning?: string;
  mimeTypeValid?: boolean;
  prefersBorder?: boolean;
}

export async function fetchMcpAppsWidgetContent(
  request: FetchMcpAppsWidgetContentRequest,
): Promise<FetchMcpAppsWidgetContentResponse> {
  const endpoint = HOSTED_MODE
    ? "/api/web/apps/mcp-apps/widget-content"
    : "/api/apps/mcp-apps/widget-content";

  const payload = HOSTED_MODE
    ? { ...buildHostedServerRequest(request.serverId) }
    : { serverId: request.serverId };

  const response = await authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
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
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new Error(
      errorData.message ||
        errorData.error ||
        `Failed to fetch widget: ${response.statusText}`,
    );
  }

  return (await response.json()) as FetchMcpAppsWidgetContentResponse;
}
