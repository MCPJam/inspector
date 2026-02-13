import { authFetch } from "@/lib/session-token";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CspMode } from "@/stores/ui-playground-store";

export interface McpAppsWidgetRequestInput {
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

export interface McpAppsWidgetContentResponse {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  permissive?: boolean;
  cspMode: CspMode;
  prefersBorder?: boolean;
  mimeType?: string;
  mimeTypeValid?: boolean;
  mimeTypeWarning?: string | null;
}

export function buildMcpAppsWidgetContentRequest(
  input: McpAppsWidgetRequestInput,
): Record<string, unknown> {
  return {
    serverId: input.serverId,
    resourceUri: input.resourceUri,
    toolInput: input.toolInput,
    toolOutput: input.toolOutput,
    toolId: input.toolId,
    toolName: input.toolName,
    theme: input.theme,
    cspMode: input.cspMode,
    template: input.template,
    viewMode: input.viewMode,
    viewParams: input.viewParams,
  };
}

export async function fetchMcpAppsWidgetContent(
  input: McpAppsWidgetRequestInput,
  fallbackError: string,
): Promise<McpAppsWidgetContentResponse> {
  const response = await authFetch("/api/mcp/apps/widget-content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildMcpAppsWidgetContentRequest(input)),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as { error?: string }).error ||
        `${fallbackError}: ${response.statusText}`,
    );
  }

  return response.json();
}
