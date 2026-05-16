import { authFetch } from "@/lib/session-token";
import { buildServerRequest } from "@/lib/apis/web/context";
import type { CspMode } from "@/stores/ui-playground-store";
import type { HostConfigMcpProfileV1 } from "@/lib/host-config-v2";

export interface WidgetCspData {
  mode: CspMode;
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains?: string[];
  headerString?: string;
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
    frame_domains?: string[];
  } | null;
}

interface BaseWidgetLoaderOptions {
  serverId: string;
  outputTemplate: string;
  resolvedToolInput: Record<string, unknown>;
  resolvedToolOutput: unknown;
  toolResponseMetadata: unknown;
  resolvedToolCallId: string;
  toolName: string;
  themeMode: string;
  locale: string;
  cspMode: CspMode;
  deviceType: string;
  /**
   * Active hostConfig.mcpProfile from the surrounding scope (chatbox
   * session, project default, eval suite). Forwarded to the widget
   * routes so saved sandbox CSP overrides legacy `cspMode`.
   * `undefined` preserves widget-derived behavior.
   */
  mcpProfile?: HostConfigMcpProfileV1;
}

interface LocalChatGptWidgetLoadOptions extends BaseWidgetLoaderOptions {
  capabilities: { hover: boolean; touch: boolean };
  safeAreaInsets: { top: number; bottom: number; left: number; right: number };
  onWidgetHtmlCaptured?: (toolCallId: string, html: string) => void;
}

export interface HostedChatGptWidgetLoadResult {
  html: string;
  csp?: WidgetCspData;
  prefersBorder: boolean;
  closeWidget: boolean;
}

export interface LocalChatGptWidgetLoadResult {
  widgetContentUrl: string;
  csp?: WidgetCspData;
  prefersBorder: boolean;
  closeWidget: boolean;
}

export async function loadHostedChatGptWidget(
  options: BaseWidgetLoaderOptions,
): Promise<HostedChatGptWidgetLoadResult> {
  const hostedServerRequest = buildServerRequest(options.serverId);
  const hostedResponse = await authFetch(
    "/api/web/apps/chatgpt-apps/widget-content",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...hostedServerRequest,
        uri: options.outputTemplate,
        toolInput: options.resolvedToolInput,
        toolOutput: options.resolvedToolOutput,
        toolResponseMetadata: options.toolResponseMetadata,
        toolId: options.resolvedToolCallId,
        toolName: options.toolName,
        theme: options.themeMode,
        locale: options.locale,
        deviceType: options.deviceType,
        userLocation: null,
        cspMode: options.cspMode,
        // Preserve `undefined` verbatim — JSON.stringify drops the key.
        // Backend distinguishes `undefined` from `{ profileVersion: 1 }`.
        ...(options.mcpProfile !== undefined
          ? { mcpProfile: options.mcpProfile }
          : {}),
      }),
    },
  );

  if (!hostedResponse.ok) {
    const hostedError = (await hostedResponse.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new Error(
      hostedError.message ||
        hostedError.error ||
        `Failed to fetch hosted widget: ${hostedResponse.statusText}`,
    );
  }

  const hostedData = (await hostedResponse.json()) as {
    html: string;
    csp?: WidgetCspData;
    prefersBorder?: boolean;
    closeWidget?: boolean;
  };

  return {
    html: hostedData.html,
    csp: hostedData.csp,
    prefersBorder: hostedData.prefersBorder ?? true,
    closeWidget: hostedData.closeWidget ?? false,
  };
}

export async function loadLocalChatGptWidget(
  options: LocalChatGptWidgetLoadOptions,
): Promise<LocalChatGptWidgetLoadResult> {
  const storeResponse = await authFetch("/api/apps/chatgpt-apps/widget/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId: options.serverId,
      uri: options.outputTemplate,
      toolInput: options.resolvedToolInput,
      toolOutput: options.resolvedToolOutput,
      toolResponseMetadata: options.toolResponseMetadata,
      toolId: options.resolvedToolCallId,
      toolName: options.toolName,
      theme: options.themeMode,
      locale: options.locale,
      deviceType: options.deviceType,
      userLocation: null,
      cspMode: options.cspMode,
      capabilities: options.capabilities,
      safeAreaInsets: options.safeAreaInsets,
      // Persist mcpProfile alongside the rest of the widget state so
      // /widget-html/:toolId and /widget-content/:toolId resolve the
      // same CSP policy.
      ...(options.mcpProfile !== undefined
        ? { mcpProfile: options.mcpProfile }
        : {}),
    }),
  });

  if (!storeResponse.ok) {
    throw new Error(`Failed to store widget data: ${storeResponse.statusText}`);
  }

  const widgetHtmlResponse = await fetch(
    `/api/apps/chatgpt-apps/widget-html/${options.resolvedToolCallId}`,
  );

  let csp: WidgetCspData | undefined;
  let closeWidget = false;
  let prefersBorder = true;

  if (widgetHtmlResponse.ok) {
    const widgetHtmlData = (await widgetHtmlResponse.json()) as {
      csp?: {
        mode: CspMode;
        connectDomains: string[];
        resourceDomains: string[];
        frameDomains?: string[];
        headerString?: string;
        widgetDeclared?: {
          connect_domains?: string[];
          resource_domains?: string[];
          frame_domains?: string[];
        } | null;
      };
      closeWidget?: boolean;
      prefersBorder?: boolean;
    };

    if (widgetHtmlData.csp) {
      csp = {
        mode: widgetHtmlData.csp.mode,
        connectDomains: widgetHtmlData.csp.connectDomains,
        resourceDomains: widgetHtmlData.csp.resourceDomains,
        frameDomains: widgetHtmlData.csp.frameDomains,
        headerString: widgetHtmlData.csp.headerString,
        widgetDeclared: widgetHtmlData.csp.widgetDeclared,
      };
    }

    closeWidget = widgetHtmlData.closeWidget ?? false;
    prefersBorder = widgetHtmlData.prefersBorder ?? true;
  }

  const widgetContentUrl = `/api/apps/chatgpt-apps/widget-content/${options.resolvedToolCallId}?csp_mode=${options.cspMode}`;

  if (options.onWidgetHtmlCaptured) {
    try {
      const contentResponse = await fetch(widgetContentUrl);
      if (contentResponse.ok) {
        const html = await contentResponse.text();
        options.onWidgetHtmlCaptured(options.resolvedToolCallId, html);
      }
    } catch (captureErr) {
      console.warn("Failed to capture widget HTML for caching:", captureErr);
    }
  }

  return {
    widgetContentUrl,
    csp,
    prefersBorder,
    closeWidget,
  };
}
