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
  resourceUri: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  /**
   * Tool response `_meta`. Flows through to
   * `window.openai.toolResponseMetadata` in the widget. Read from
   * `rawOutput._meta` at the renderer layer; pass null when absent.
   */
  toolResponseMetadata?: Record<string, unknown> | null;
  /**
   * Persisted widget state from a saved view or fork. When set, the
   * compat runtime seeds `window.openai.widgetState` so the widget
   * boots in the previously-saved state instead of fresh defaults.
   */
  initialWidgetState?: unknown;
  toolId: string;
  toolName: string;
  theme: string;
  cspMode: CspMode;
  /**
   * Resolved compat-runtime flag — when true the server injects the
   * OpenAI Apps SDK `window.openai` shim into the widget HTML. Caller
   * must compute this from the active host config via
   * `resolveEffectiveCompatRuntime` so the wire body and the renderer's
   * reload-key state agree on what's about to be rendered.
   */
  injectOpenAiCompat: boolean;
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
  /**
   * Server-confirmed compat-runtime flag — echoes what the route
   * decided after applying its `injectOpenAiCompat === true` gate.
   * Caller can persist this alongside cached HTML to remove ambiguity
   * when replaying the snapshot under a different host config.
   */
  injectedOpenAiCompat?: boolean;
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
      toolInput: request.toolInput,
      toolOutput: request.toolOutput,
      toolResponseMetadata: request.toolResponseMetadata ?? null,
      initialWidgetState: request.initialWidgetState ?? null,
      toolId: request.toolId,
      toolName: request.toolName,
      theme: request.theme,
      cspMode: request.cspMode,
      injectOpenAiCompat: request.injectOpenAiCompat,
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
