import type { MCPClientManager } from "@mcpjam/sdk";
import {
  MCP_UI_RESOURCE_MIME_TYPE,
  buildChatGptRuntimeHead,
  buildCspHeader,
  buildCspMetaContent,
  injectOpenAICompat,
  injectScripts,
  type WidgetCspMeta,
} from "@mcpjam/sdk";
import { cliError, usageError } from "./output.js";

type Manager = MCPClientManager;

type CspMode = "permissive" | "widget-declared";

export function parseTheme(
  value: string | undefined,
): "light" | "dark" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "light" || value === "dark") {
    return value;
  }
  throw usageError(`Invalid theme "${value}". Use "light" or "dark".`);
}

export interface McpWidgetOptions {
  resourceUri: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
}

export interface ChatGptWidgetOptions {
  uri: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  locale?: string;
  deviceType?: "mobile" | "tablet" | "desktop";
}

export async function buildMcpWidgetContent(
  manager: Manager,
  serverId: string,
  options: McpWidgetOptions,
) {
  if (options.template && !options.template.startsWith("ui://")) {
    throw cliError("VALIDATION_ERROR", "Template must use ui:// protocol");
  }

  const resolvedResourceUri = options.template || options.resourceUri;
  const effectiveCspMode = options.cspMode ?? "permissive";
  const resourceResult = await manager.readResource(serverId, {
    uri: resolvedResourceUri,
  });

  const contents = Array.isArray((resourceResult as any)?.contents)
    ? (resourceResult as any).contents
    : [];
  const content = contents[0];
  if (!content) {
    throw cliError("NOT_FOUND", "No content in resource");
  }

  const contentMimeType = (content as { mimeType?: string }).mimeType;
  const mimeTypeValid = contentMimeType === MCP_UI_RESOURCE_MIME_TYPE;
  const mimeTypeWarning = !mimeTypeValid
    ? contentMimeType
      ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${MCP_UI_RESOURCE_MIME_TYPE}"`
      : `Missing mimetype - SEP-1865 requires "${MCP_UI_RESOURCE_MIME_TYPE}"`
    : null;

  let html = extractHtmlFromResourceContent(content);
  if (!html) {
    throw cliError("NOT_FOUND", "No HTML content in resource");
  }

  const uiMeta = (content._meta as { ui?: any } | undefined)?.ui;
  html = injectOpenAICompat(html, {
    toolId: options.toolId,
    toolName: options.toolName,
    toolInput: options.toolInput ?? {},
    toolOutput: options.toolOutput,
    theme: options.theme,
    viewMode: options.viewMode,
    viewParams: options.viewParams,
  });

  return {
    html,
    csp: effectiveCspMode === "permissive" ? undefined : uiMeta?.csp,
    permissions: uiMeta?.permissions,
    permissive: effectiveCspMode === "permissive",
    cspMode: effectiveCspMode,
    prefersBorder: uiMeta?.prefersBorder,
    mimeType: contentMimeType,
    mimeTypeValid,
    mimeTypeWarning,
  };
}

export async function buildChatGptWidgetContent(
  manager: Manager,
  serverId: string,
  options: ChatGptWidgetOptions,
) {
  const content = await manager.readResource(serverId, { uri: options.uri });
  const contentsArray = Array.isArray((content as any)?.contents)
    ? (content as any).contents
    : [];
  const firstContent = contentsArray[0];
  if (!firstContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }

  const htmlContent = extractHtmlFromResourceContent(firstContent);
  if (!htmlContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }

  const resourceMeta = firstContent?._meta as
    | Record<string, unknown>
    | undefined;
  const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
    | WidgetCspMeta
    | undefined;
  const effectiveCspMode = options.cspMode ?? "permissive";
  const cspConfig = buildCspHeader(effectiveCspMode, widgetCspRaw);

  const runtimeHeadContent = buildChatGptRuntimeHead({
    htmlContent,
    runtimeConfig: {
      toolId: options.toolId,
      toolName: options.toolName,
      toolInput: options.toolInput ?? {},
      toolOutput: options.toolOutput ?? null,
      toolResponseMetadata: options.toolResponseMetadata ?? null,
      theme: options.theme ?? "dark",
      locale: options.locale ?? "en-US",
      deviceType: options.deviceType ?? "desktop",
      viewMode: "inline",
      viewParams: {},
      useMapPendingCalls: true,
    },
  });

  let cspMetaTag = "";
  if (cspConfig.headerString) {
    const metaCspContent = buildCspMetaContent(cspConfig.headerString);
    cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${metaCspContent.replace(
      /"/g,
      "&quot;",
    )}">`;
  }

  return {
    html: injectScripts(htmlContent, cspMetaTag + runtimeHeadContent),
    csp: {
      mode: cspConfig.mode,
      connectDomains: cspConfig.connectDomains,
      resourceDomains: cspConfig.resourceDomains,
      frameDomains: cspConfig.frameDomains,
      headerString: cspConfig.headerString,
      widgetDeclared: widgetCspRaw ?? null,
    },
    widgetDescription: resourceMeta?.["openai/widgetDescription"] as
      | string
      | undefined,
    prefersBorder:
      (resourceMeta?.["openai/widgetPrefersBorder"] as boolean | undefined) ??
      true,
    closeWidget:
      (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ?? false,
  };
}

function extractHtmlFromResourceContent(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }

  const record = content as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.blob === "string") {
    return Buffer.from(record.blob, "base64").toString("utf-8");
  }
  return "";
}
