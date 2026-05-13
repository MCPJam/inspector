import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { buildServerRequest } from "@/lib/apis/web/context";
import type { CspMode } from "@/stores/ui-playground-store";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface FetchMcpAppsWidgetContentRequest {
  serverId: string;
  /**
   * MCP Apps SEP-1865 discovery channel. Either this or
   * `openaiOutputTemplate` must be set; the dispatcher chooses based on
   * the tool's `_meta` shape and the active hostStyle / unified-renderer
   * preference. The server returns 400 if both are sent.
   */
  resourceUri?: string;
  /**
   * OpenAI Apps SDK discovery channel (`_meta["openai/outputTemplate"]`).
   * Routed to the unified renderer when the preferences flag is on. The
   * URL is opaque to the dispatcher — the server reads OpenAI-specific
   * fields (`openai/widgetCSP`, `openai/widgetPrefersBorder`) from the
   * resource `_meta`.
   */
  openaiOutputTemplate?: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  /**
   * Fidelity field forwarded from the OpenAI Apps SDK widget envelope.
   * Used by the unified renderer to surface tool-response metadata
   * (timestamps, citations, etc.) inside the iframe runtime. `null`
   * means the upstream tool result carried no metadata.
   */
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme: string;
  /**
   * BCP-47 locale forwarded to the widget runtime (`window.openai.locale`
   * for OpenAI-compat, `hostContext.locale` for MCP Apps). Optional;
   * server falls back to "en-US" when omitted.
   */
  locale?: string;
  /**
   * Device class forwarded to the widget runtime. Used by widgets to
   * adjust touch targets and layout. Server default is "desktop".
   */
  deviceType?: "mobile" | "tablet" | "desktop";
  cspMode: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
  /**
   * Stage 2 gate. Resolved by the caller via
   * `resolveOpenAiCompatEnabled({ mcpProfile, hostStyle })`; the server
   * does NOT consult hostStyle. When `true`, the server injects
   * `window.openai` into the iframe HTML via `injectOpenAICompat` with
   * `useLocalStorageWidgetState: true`.
   */
  injectOpenAiCompatRuntime?: boolean;
}

export interface FetchMcpAppsWidgetContentResponse {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  permissive?: boolean;
  mimeTypeWarning?: string;
  mimeTypeValid?: boolean;
  prefersBorder?: boolean;
  /**
   * Echo of the discovery channel the server used to read the resource
   * `_meta`. "mcp-apps" reads `_meta.ui.*`; "openai" reads
   * `_meta["openai/*"]`. Useful for the dispatcher's debug overlay and
   * for Stage 3 telemetry partitioning OpenAI vs MCP Apps widgets within
   * the unified renderer.
   */
  discoveryChannel?: "mcp-apps" | "openai";
}

export async function fetchMcpAppsWidgetContent(
  request: FetchMcpAppsWidgetContentRequest,
): Promise<FetchMcpAppsWidgetContentResponse> {
  const endpoint = HOSTED_MODE
    ? "/api/web/apps/mcp-apps/widget-content"
    : "/api/apps/mcp-apps/widget-content";

  const payload = HOSTED_MODE
    ? { ...buildServerRequest(request.serverId) }
    : { serverId: request.serverId };

  const response = await authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      resourceUri: request.resourceUri,
      openaiOutputTemplate: request.openaiOutputTemplate,
      toolInput: request.toolInput,
      toolOutput: request.toolOutput,
      toolResponseMetadata: request.toolResponseMetadata,
      toolId: request.toolId,
      toolName: request.toolName,
      theme: request.theme,
      locale: request.locale,
      deviceType: request.deviceType,
      cspMode: request.cspMode,
      template: request.template,
      viewMode: request.viewMode,
      viewParams: request.viewParams,
      injectOpenAiCompatRuntime: request.injectOpenAiCompatRuntime,
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
