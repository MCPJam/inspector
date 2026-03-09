import type {
  EvalWidgetCsp,
  EvalWidgetPermissions,
  EvalWidgetSnapshotInput,
} from "./eval-reporting-types.js";

type ResourceContent = {
  text?: string;
  blob?: string;
  _meta?: {
    ui?: {
      csp?: EvalWidgetCsp;
      permissions?: EvalWidgetPermissions;
      prefersBorder?: boolean;
    };
  };
  mimeType?: string;
};

export function extractHtmlFromResourceContent(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }

  const resourceContent = content as ResourceContent;
  if (typeof resourceContent.text === "string") {
    return resourceContent.text;
  }
  if (typeof resourceContent.blob === "string") {
    return Buffer.from(resourceContent.blob, "base64").toString("utf-8");
  }
  return "";
}

export function buildMcpAppWidgetSnapshot(params: {
  toolCallId: string;
  toolName: string;
  serverId: string;
  resourceUri: string;
  toolMetadata: Record<string, unknown>;
  resourceContent: unknown;
}): EvalWidgetSnapshotInput | null {
  const html = extractHtmlFromResourceContent(params.resourceContent);
  if (!html) {
    return null;
  }

  const resourceContent = params.resourceContent as ResourceContent | undefined;
  const uiMeta = resourceContent?._meta?.ui;

  return {
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    protocol: "mcp-apps",
    serverId: params.serverId,
    resourceUri: params.resourceUri,
    toolMetadata: params.toolMetadata,
    widgetCsp: uiMeta?.csp ?? null,
    widgetPermissions: uiMeta?.permissions ?? null,
    widgetPermissive: true,
    prefersBorder: uiMeta?.prefersBorder ?? true,
    widgetHtml: html,
  };
}
