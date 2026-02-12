import { useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { authFetch } from "@/lib/session-token";
import { extractMethod } from "@/stores/traffic-log-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CspMode } from "@/stores/ui-playground-store";
import { LoggingTransport } from "./mcp-apps-logging-transport";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

export interface McpAppsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  template: string | null;
  params: Record<string, unknown>;
  registerBridgeHandlers: (bridge: AppBridge) => void;
  widgetCsp: McpUiResourceCsp | undefined;
  widgetPermissions: McpUiResourcePermissions | undefined;
  widgetPermissive: boolean;
  hostContextRef: React.RefObject<McpUiHostContext | null>;
  serverId: string;
  resourceUri: string;
  toolCallId: string;
  toolName: string;
  cspMode: CspMode;
  toolInputRef: React.RefObject<Record<string, unknown> | undefined>;
  toolOutputRef: React.RefObject<unknown>;
  themeModeRef: React.RefObject<string>;
  addUiLog: (log: {
    widgetId: string;
    serverId: string;
    direction: "host-to-ui" | "ui-to-host";
    protocol: string;
    method: string;
    message: unknown;
  }) => void;
  onCspViolation: (event: MessageEvent) => void;
}

export function McpAppsModal({
  open,
  onOpenChange,
  title,
  template,
  params,
  registerBridgeHandlers,
  widgetCsp,
  widgetPermissions,
  widgetPermissive,
  hostContextRef,
  serverId,
  resourceUri,
  toolCallId,
  toolName,
  cspMode,
  toolInputRef,
  toolOutputRef,
  themeModeRef,
  addUiLog,
  onCspViolation,
}: McpAppsModalProps) {
  const [modalHtml, setModalHtml] = useState<string | null>(null);
  const modalSandboxRef = useRef<SandboxedIframeHandle>(null);
  const modalBridgeRef = useRef<AppBridge | null>(null);

  // Fetch modal HTML when modal opens
  useEffect(() => {
    if (!open) {
      // Clean up when modal closes
      modalBridgeRef.current?.close().catch(() => {});
      modalBridgeRef.current = null;
      setModalHtml(null);
      return;
    }

    const fetchModalHtml = async () => {
      try {
        // Store widget data (server already has it, but refresh timestamp)
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
          throw new Error(
            `Failed to store widget: ${storeResponse.statusText}`,
          );
        }

        // Build URL with optional template override and modal view params
        const urlParams = new URLSearchParams({ csp_mode: cspMode });
        if (template) {
          urlParams.set("template", template);
        }
        urlParams.set("view_mode", "modal");
        urlParams.set("view_params", JSON.stringify(params));

        const contentResponse = await authFetch(
          `/api/mcp/apps/widget-content/${toolCallId}?${urlParams.toString()}`,
        );
        if (!contentResponse.ok) {
          const errorData = await contentResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `Failed to fetch modal widget: ${contentResponse.statusText}`,
          );
        }
        const { html } = await contentResponse.json();
        setModalHtml(html);
      } catch (err) {
        console.error("[MCP Apps] Failed to fetch modal HTML", err);
      }
    };

    fetchModalHtml();
  }, [
    open,
    template,
    params,
    serverId,
    resourceUri,
    toolCallId,
    toolName,
    cspMode,
    toolInputRef,
    toolOutputRef,
    themeModeRef,
  ]);

  // Initialize modal bridge when modal HTML is ready
  useEffect(() => {
    if (!modalHtml || !open) return;
    const iframe = modalSandboxRef.current?.getIframeElement();
    if (!iframe?.contentWindow) return;

    const bridge = new AppBridge(
      null,
      { name: "mcpjam-inspector", version: __APP_VERSION__ },
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        sandbox: {
          csp: widgetPermissive ? undefined : widgetCsp,
          permissions: widgetPermissions,
        },
      },
      { hostContext: hostContextRef.current ?? {} },
    );

    // Reuse the same handlers as the inline bridge
    registerBridgeHandlers(bridge);

    // Override onsizechange to target modal iframe instead of main widget
    bridge.onsizechange = ({ width, height }) => {
      const modalIframe = modalSandboxRef.current?.getIframeElement();
      if (!modalIframe) return;

      if (height !== undefined) {
        const style = getComputedStyle(modalIframe);
        const isBorderBox = style.boxSizing === "border-box";

        let adjustedHeight = height;
        if (isBorderBox) {
          adjustedHeight +=
            parseFloat(style.borderTopWidth) +
            parseFloat(style.borderBottomWidth);
        }

        modalIframe.style.height = `${adjustedHeight}px`;
      }

      if (width !== undefined) {
        modalIframe.style.width = `${width}px`;
      }
    };

    // Override oninitialized so it doesn't set the main isReady state
    bridge.oninitialized = () => {
      // Send tool input/output to the modal bridge after initialization
      const resolvedToolInput = toolInputRef.current ?? {};
      bridge.sendToolInput({ arguments: resolvedToolInput });
      if (toolOutputRef.current) {
        bridge.sendToolResult(toolOutputRef.current as CallToolResult);
      }
    };

    modalBridgeRef.current = bridge;

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          addUiLog({
            widgetId: `${toolCallId}-modal`,
            serverId,
            direction: "host-to-ui",
            protocol: "mcp-apps",
            method: extractMethod(message, "mcp-apps"),
            message,
          });
        },
        onReceive: (message) => {
          addUiLog({
            widgetId: `${toolCallId}-modal`,
            serverId,
            direction: "ui-to-host",
            protocol: "mcp-apps",
            method: extractMethod(message, "mcp-apps"),
            message,
          });
        },
      },
    );

    let isActive = true;
    bridge.connect(transport).catch((error) => {
      if (!isActive) return;
      console.error("[MCP Apps] Modal bridge connection failed", error);
    });

    return () => {
      isActive = false;
      modalBridgeRef.current = null;
      bridge.close().catch(() => {});
    };
  }, [
    modalHtml,
    open,
    addUiLog,
    serverId,
    toolCallId,
    registerBridgeHandlers,
    widgetPermissive,
    widgetCsp,
    widgetPermissions,
    hostContextRef,
    toolInputRef,
    toolOutputRef,
  ]);

  const handleModalMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data) return;

    // Forward CSP violations to parent handler
    if (data.type === "mcp-apps:csp-violation") {
      onCspViolation(event);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-fit max-w-[90vw] h-fit max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 w-full h-full min-h-0 overflow-auto">
          {modalHtml && (
            <SandboxedIframe
              ref={modalSandboxRef}
              html={modalHtml}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              csp={widgetCsp}
              permissions={widgetPermissions}
              permissive={widgetPermissive}
              onMessage={handleModalMessage}
              title={`MCP App Modal: ${title}`}
              className="min-w-full border-0 rounded-md bg-background overflow-hidden"
              style={{ height: "100%", minHeight: "400px" }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
