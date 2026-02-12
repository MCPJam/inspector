import { useEffect, useRef } from "react";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { extractMethod } from "@/stores/traffic-log-store";
import { LoggingTransport } from "./mcp-apps-logging-transport";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

export function createMcpAppsBridge({
  hostContext,
  csp,
  permissions,
  permissive,
}: {
  hostContext: McpUiHostContext;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  permissive: boolean;
}) {
  return new AppBridge(
    null,
    { name: "mcpjam-inspector", version: __APP_VERSION__ },
    {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      sandbox: {
        csp: permissive ? undefined : csp,
        permissions,
      },
    },
    { hostContext },
  );
}

export function createMcpAppsLoggingTransport({
  contentWindow,
  onSend,
  onReceive,
}: {
  contentWindow: Window;
  onSend?: (message: unknown, method: string) => void;
  onReceive?: (message: unknown, method: string) => void;
}) {
  return new LoggingTransport(
    new PostMessageTransport(contentWindow, contentWindow),
    {
      onSend: (message) => {
        const method = extractMethod(message, "mcp-apps");
        onSend?.(message, method);
      },
      onReceive: (message) => {
        const method = extractMethod(message, "mcp-apps");
        onReceive?.(message, method);
      },
    },
  );
}

interface UseMcpAppsBridgeArgs {
  widgetHtml: string | null;
  getSandboxIframe: () => HTMLIFrameElement | null;
  bridgeRef: { current: AppBridge | null };
  hostContext: McpUiHostContext;
  widgetCsp?: McpUiResourceCsp;
  widgetPermissions?: McpUiResourcePermissions;
  widgetPermissive: boolean;
  registerBridgeHandlers: (bridge: AppBridge) => void;
  widgetId: string;
  serverId: string;
  suppressedMethods: ReadonlySet<string>;
  onUiLog: (entry: {
    widgetId: string;
    serverId: string;
    direction: "host-to-ui" | "ui-to-host";
    protocol: "mcp-apps";
    method: string;
    message: unknown;
  }) => void;
  onLoadError: (message: string) => void;
  onSetReady: (ready: boolean) => void;
  onReceiveSizeChanged: () => void;
  onBeforeClose?: (bridge: AppBridge) => void;
}

export function useMcpAppsBridge({
  widgetHtml,
  getSandboxIframe,
  bridgeRef,
  hostContext,
  widgetCsp,
  widgetPermissions,
  widgetPermissive,
  registerBridgeHandlers,
  widgetId,
  serverId,
  suppressedMethods,
  onUiLog,
  onLoadError,
  onSetReady,
  onReceiveSizeChanged,
  onBeforeClose,
}: UseMcpAppsBridgeArgs) {
  const hostContextRef = useRef(hostContext);
  hostContextRef.current = hostContext;

  useEffect(() => {
    const sandboxIframe = getSandboxIframe();
    if (!widgetHtml || !sandboxIframe?.contentWindow) return;

    onSetReady(false);

    const bridge = createMcpAppsBridge({
      hostContext: hostContextRef.current,
      csp: widgetCsp,
      permissions: widgetPermissions,
      permissive: widgetPermissive,
    });

    registerBridgeHandlers(bridge);
    bridgeRef.current = bridge;

    const transport = createMcpAppsLoggingTransport({
      contentWindow: sandboxIframe.contentWindow,
      onSend: (message, method) => {
        if (suppressedMethods.has(method)) return;
        onUiLog({
          widgetId,
          serverId,
          direction: "host-to-ui",
          protocol: "mcp-apps",
          method,
          message,
        });
      },
      onReceive: (message, method) => {
        if (method === "ui/notifications/size-changed") {
          onReceiveSizeChanged();
        }
        if (suppressedMethods.has(method)) return;
        onUiLog({
          widgetId,
          serverId,
          direction: "ui-to-host",
          protocol: "mcp-apps",
          method,
          message,
        });
      },
    });

    let isActive = true;
    bridge.connect(transport).catch((error) => {
      if (!isActive) return;
      onLoadError(
        error instanceof Error ? error.message : "Failed to connect MCP App",
      );
    });

    return () => {
      isActive = false;
      bridgeRef.current = null;
      onBeforeClose?.(bridge);
      void bridge.close().catch(() => {});
    };
  }, [
    getSandboxIframe,
    bridgeRef,
    onBeforeClose,
    onLoadError,
    onReceiveSizeChanged,
    onSetReady,
    onUiLog,
    registerBridgeHandlers,
    serverId,
    suppressedMethods,
    widgetCsp,
    widgetHtml,
    widgetId,
    widgetPermissions,
    widgetPermissive,
  ]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setHostContext(hostContext);
  }, [bridgeRef, hostContext]);
}
