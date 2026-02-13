import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { LoggingTransport } from "./mcp-apps-logging-transport";

interface BridgeLogCallbacks {
  onSend: (message: unknown) => void;
  onReceive: (message: unknown) => void;
}

interface CreateMcpAppsBridgeOptions {
  appVersion: string;
  iframeWindow: Window;
  hostContext: McpUiHostContext;
  csp: McpUiResourceCsp | undefined;
  permissions: McpUiResourcePermissions | undefined;
  permissive: boolean;
  registerBridgeHandlers: (bridge: AppBridge) => void;
  logs: BridgeLogCallbacks;
}

export function createMcpAppsBridge({
  appVersion,
  iframeWindow,
  hostContext,
  csp,
  permissions,
  permissive,
  registerBridgeHandlers,
  logs,
}: CreateMcpAppsBridgeOptions): {
  bridge: AppBridge;
  transport: LoggingTransport;
} {
  const bridge = new AppBridge(
    null,
    { name: "mcpjam-inspector", version: appVersion },
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

  registerBridgeHandlers(bridge);

  const transport = new LoggingTransport(
    new PostMessageTransport(iframeWindow, iframeWindow),
    {
      onSend: logs.onSend,
      onReceive: logs.onReceive,
    },
  );

  return { bridge, transport };
}
