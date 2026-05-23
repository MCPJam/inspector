import { useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { extractMethod } from "@/stores/traffic-log-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { CspMode } from "@/stores/ui-playground-store";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { resolveHostInfo } from "@/lib/client-config-v2";

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
  widgetSandboxAttrs: string[] | undefined;
  widgetAllowFeatures: Record<string, string> | undefined;
  widgetCspDirectives: Record<string, string[]> | undefined;
  hostContextRef: React.RefObject<McpUiHostContext | null>;
  serverId: string;
  resourceUri: string;
  toolCallId: string;
  toolName: string;
  cspMode: CspMode;
  /**
   * Resolved compat-runtime flag the inline renderer already computed
   * for this host. The modal mounts its own iframe and fetches its own
   * HTML; passing the flag down (rather than re-resolving here) keeps
   * the modal and inline fetches in lockstep so the modal can't end up
   * shimmed while the inline view isn't (or vice versa).
   */
  injectOpenAiCompat: boolean;
  /**
   * Resolved MCP Apps `HostCapabilities` blob the inline renderer
   * already computed via `resolveEffectiveHostCapabilities`. Pass-down
   * mirrors {@link injectOpenAiCompat}: the modal mounts its own
   * AppBridge and we want inline + modal to advertise an identical
   * surface to the widget. Previously the modal hardcoded `{ openLinks,
   * serverTools, serverResources, logging, updateModelContext, message }`
   * — that masked Copilot's M365-published subset (which strips
   * `serverResources` / `logging`) and any user override in
   * `mcpProfile.apps.mcpAppsOverrides`. The `sandbox` slice is composed
   * separately at AppBridge construction from the widget-level CSP /
   * permissions props.
   */
  effectiveHostCapabilities: Omit<McpUiHostCapabilities, "sandbox">;
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
  widgetSandboxAttrs,
  widgetAllowFeatures,
  widgetCspDirectives,
  hostContextRef,
  serverId,
  resourceUri,
  toolCallId,
  toolName,
  cspMode,
  injectOpenAiCompat,
  effectiveHostCapabilities,
  toolInputRef,
  toolOutputRef,
  themeModeRef,
  addUiLog,
  onCspViolation,
}: McpAppsModalProps) {
  const [modalHtml, setModalHtml] = useState<string | null>(null);
  const modalSandboxRef = useRef<SandboxedIframeHandle>(null);
  const modalBridgeRef = useRef<AppBridge | null>(null);
  // Same scope as the inline renderer — `ActiveMcpProfileProvider` wraps
  // both. Used to resolve `hostInfo` for the modal's AppBridge handshake.
  const activeMcpProfile = useActiveMcpProfile();
  const modalColorScheme =
    hostContextRef.current?.theme === "light" ||
    hostContextRef.current?.theme === "dark"
      ? hostContextRef.current.theme
      : themeModeRef.current === "light" || themeModeRef.current === "dark"
        ? themeModeRef.current
        : undefined;

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
        const { html } = await fetchMcpAppsWidgetContent({
          serverId,
          resourceUri,
          toolInput: toolInputRef.current,
          toolOutput: toolOutputRef.current,
          toolId: toolCallId,
          toolName,
          theme: themeModeRef.current,
          cspMode,
          injectOpenAiCompat,
          template: template ?? undefined,
          viewMode: "modal",
          viewParams: params,
        });
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
    injectOpenAiCompat,
    toolInputRef,
    toolOutputRef,
    themeModeRef,
  ]);

  // Initialize modal bridge when modal HTML is ready
  useEffect(() => {
    if (!modalHtml || !open) return;
    const iframe = modalSandboxRef.current?.getIframeElement();
    if (!iframe?.contentWindow) return;

    // Match the inline renderer: ChatGPT-like templates override this
    // via mcpProfile.apps.uiInitialize.hostInfo. Backend soft-validates
    // name+version when set, so the cast below is safe.
    const resolvedHostInfo = (resolveHostInfo(activeMcpProfile) ?? {
      name: "mcpjam-inspector",
      version: __APP_VERSION__,
    }) as { name: string; version: string };
    // Vendor-trait HostCapabilities come from the inline renderer's
    // resolver (matrix-derived + user override). Sandbox is composed
    // here from the widget-level resource CSP / permissions per
    // SEP-1865 (sandbox is per-resource, not a vendor trait — see
    // HostMcpProfile.mcpAppsCapabilities doc).
    const bridge = new AppBridge(
      null,
      resolvedHostInfo,
      {
        ...effectiveHostCapabilities,
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
    activeMcpProfile,
    effectiveHostCapabilities,
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
              sandboxAttrs={widgetSandboxAttrs}
              allowFeatures={widgetAllowFeatures}
              cspDirectives={widgetCspDirectives}
              colorScheme={modalColorScheme}
              onMessage={handleModalMessage}
              title={`MCP App Modal: ${title}`}
              className="min-w-full border-0 rounded-md bg-transparent overflow-hidden"
              style={{
                height: "100%",
                minHeight: "400px",
                backgroundColor: "transparent",
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
