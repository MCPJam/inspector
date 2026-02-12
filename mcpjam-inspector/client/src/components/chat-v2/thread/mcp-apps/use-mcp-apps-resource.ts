import { useEffect, useRef, useState } from "react";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { authFetch } from "@/lib/session-token";
import type { CspMode } from "@/stores/ui-playground-store";
import type { ToolState } from "./mcp-apps-types";

interface UseMcpAppsResourceArgs {
  toolState?: ToolState;
  toolCallId: string;
  serverId: string;
  resourceUri: string;
  toolName: string;
  cspMode: CspMode;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  themeMode: string;
  setWidgetHtmlStore: (toolCallId: string, html: string) => void;
  setWidgetCspStore: (
    toolCallId: string,
    value: {
      mode: "permissive" | "widget-declared";
      connectDomains: string[];
      resourceDomains: string[];
      frameDomains: string[];
      baseUriDomains: string[];
      permissions: McpUiResourcePermissions | undefined;
      widgetDeclared: {
        connectDomains: string[] | undefined;
        resourceDomains: string[] | undefined;
        frameDomains: string[] | undefined;
        baseUriDomains: string[] | undefined;
      } | null;
    },
  ) => void;
}

export function useMcpAppsResource({
  toolState,
  toolCallId,
  serverId,
  resourceUri,
  toolName,
  cspMode,
  isOffline,
  cachedWidgetHtmlUrl,
  toolInput,
  toolOutput,
  themeMode,
  setWidgetHtmlStore,
  setWidgetCspStore,
}: UseMcpAppsResourceArgs) {
  const [html, setHtml] = useState<string | null>(null);
  const [csp, setCsp] = useState<McpUiResourceCsp | undefined>(undefined);
  const [permissions, setPermissions] = useState<
    McpUiResourcePermissions | undefined
  >(undefined);
  const [permissive, setPermissive] = useState(false);
  const [prefersBorder, setPrefersBorder] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);

  const toolInputRef = useRef(toolInput);
  toolInputRef.current = toolInput;
  const toolOutputRef = useRef(toolOutput);
  toolOutputRef.current = toolOutput;
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;

  useEffect(() => {
    setHtml(null);
    setLoadedCspMode(null);
    setLoadError(null);
  }, [cachedWidgetHtmlUrl]);

  useEffect(() => {
    const isActiveToolState =
      toolState === "input-streaming" ||
      toolState === "input-available" ||
      toolState === "output-available";

    if (!isActiveToolState) return;
    if (html && loadedCspMode === cspMode) return;

    const fetchWidgetHtml = async () => {
      try {
        setLoadError(null);

        if (cachedWidgetHtmlUrl) {
          const cachedResponse = await fetch(cachedWidgetHtmlUrl);
          if (!cachedResponse.ok) {
            throw new Error(
              `Failed to fetch cached widget HTML: ${cachedResponse.statusText}`,
            );
          }
          const cachedHtml = await cachedResponse.text();
          setHtml(cachedHtml);
          setPermissive(true);
          setPrefersBorder(true);
          setLoadedCspMode(cspMode);
          return;
        }

        if (isOffline) {
          setLoadError(
            "Server is offline and this view was saved without cached HTML. Connect the server and re-save the view to enable offline rendering.",
          );
          return;
        }

        const storeResponse = await authFetch("/api/mcp/apps/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            resourceUri,
            toolInput: toolInputRef.current,
            toolOutput: toolOutputRef.current,
            toolId: toolCallId,
            toolName,
            theme: themeModeRef.current,
            protocol: "mcp-apps",
            cspMode,
          }),
        });

        if (!storeResponse.ok) {
          throw new Error(`Failed to store widget: ${storeResponse.statusText}`);
        }

        const contentResponse = await fetch(
          `/api/mcp/apps/widget-content/${toolCallId}?csp_mode=${cspMode}`,
        );

        if (!contentResponse.ok) {
          const errorData = await contentResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `Failed to fetch widget: ${contentResponse.statusText}`,
          );
        }

        const {
          html,
          csp,
          permissions,
          permissive,
          mimeTypeWarning: warning,
          mimeTypeValid: valid,
          prefersBorder,
        } = await contentResponse.json();

        if (!valid) {
          setLoadError(
            warning ||
              'Invalid mimetype - SEP-1865 requires "text/html;profile=mcp-app"',
          );
          return;
        }

        setHtml(html);
        setCsp(csp);
        setPermissions(permissions);
        setPermissive(permissive ?? false);
        setPrefersBorder(prefersBorder ?? true);
        setLoadedCspMode(cspMode);

        setWidgetHtmlStore(toolCallId, html);

        if (csp || permissions || !permissive) {
          setWidgetCspStore(toolCallId, {
            mode: permissive ? "permissive" : "widget-declared",
            connectDomains: csp?.connectDomains || [],
            resourceDomains: csp?.resourceDomains || [],
            frameDomains: csp?.frameDomains || [],
            baseUriDomains: csp?.baseUriDomains || [],
            permissions,
            widgetDeclared: csp
              ? {
                  connectDomains: csp.connectDomains,
                  resourceDomains: csp.resourceDomains,
                  frameDomains: csp.frameDomains,
                  baseUriDomains: csp.baseUriDomains,
                }
              : null,
          });
        }
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "Failed to prepare widget",
        );
      }
    };

    void fetchWidgetHtml();
  }, [
    cachedWidgetHtmlUrl,
    cspMode,
    html,
    isOffline,
    loadedCspMode,
    resourceUri,
    serverId,
    setWidgetCspStore,
    setWidgetHtmlStore,
    toolCallId,
    toolName,
    toolState,
  ]);

  return {
    html,
    csp,
    permissions,
    permissive,
    prefersBorder,
    loadError,
    loadedCspMode,
  };
}
