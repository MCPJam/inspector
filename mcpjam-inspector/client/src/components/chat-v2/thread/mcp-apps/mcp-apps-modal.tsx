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
import { useAppToolsRegistry } from "./app-tools-registry";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

export interface McpAppsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  template: string | null;
  params: Record<string, unknown>;
  registerBridgeHandlers: (bridge: AppBridge) => void;
  /**
   * SEP-1865 App-Provided Tools: the modal mounts its own AppBridge
   * against a fresh iframe. Because the modal overrides
   * `bridge.oninitialized` to suppress inline-only side effects, the
   * inline registration path (which lives inside that handler) is
   * skipped. The modal calls this helper directly after handshake — and
   * again on every `notifications/tools/list_changed` — so the model
   * sees the app's tools while the modal is the active surface for this
   * tool call. Inline + modal coexist in `useAppToolsRegistry` via
   * `surface`-keyed dedup; the registry's active-bridge fallback
   * restores inline when the modal unregisters on teardown.
   */
  refreshAppProvidedTools: (
    bridge: AppBridge,
    bridgeId: string,
    options?: {
      force?: boolean;
      surface?: "inline" | "modal";
      getIframeElement?: () => HTMLIFrameElement | null;
      isLive?: () => boolean;
    }
  ) => Promise<void>;
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
  /**
   * SEP-1865 App-Provided Tools host policy. `false` means the host has
   * withdrawn the agent-facing tool surface; the modal must unregister
   * its instance from `useAppToolsRegistry` even while its iframe stays
   * mounted. `true` re-arms registration if the modal's guest already
   * advertised `tools` in `ui/initialize` and the bridge is still live.
   * The view itself is unaffected — only the model-visible aliases.
   */
  appToolsPolicyEnabled: boolean;
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
  refreshAppProvidedTools,
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
  appToolsPolicyEnabled,
  toolInputRef,
  toolOutputRef,
  themeModeRef,
  addUiLog,
  onCspViolation,
}: McpAppsModalProps) {
  const [modalHtml, setModalHtml] = useState<string | null>(null);
  const modalSandboxRef = useRef<SandboxedIframeHandle>(null);
  const modalBridgeRef = useRef<AppBridge | null>(null);
  // SEP-1865 App-Provided Tools: per-modal-bridge identity. Distinct
  // from the renderer's inline ref so inline + modal can coexist in
  // `useAppToolsRegistry` and `surface`-keyed dedup keeps each surface's
  // tools separate. Cleared on teardown so `isLive` short-circuits any
  // in-flight `listTools` after the modal closes.
  const modalAppToolsBridgeIdRef = useRef<string | null>(null);
  // Tracks whether the modal's guest advertised `tools` in
  // `ui/initialize`. Gates the policy re-enable effect below so a
  // mid-session toggle can't synthesize a registration the guest never
  // advertised. Reset to false when the bridge effect tears down.
  const modalAppAdvertisedToolsRef = useRef(false);
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
      // SEP-1865 App-Provided Tools: drop this modal's registration so
      // the next chat POST snapshot omits its aliases and the registry's
      // active-bridge fallback restores any coexisting inline surface.
      if (modalAppToolsBridgeIdRef.current) {
        useAppToolsRegistry
          .getState()
          .unregisterInstance(modalAppToolsBridgeIdRef.current);
        modalAppToolsBridgeIdRef.current = null;
      }
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

    // Override oninitialized so it doesn't set the main isReady state.
    // SEP-1865 App-Provided Tools: this replaces (not wraps) the
    // inline handler set by `registerBridgeHandlers`, so we have to
    // re-run the parts of that handler that matter for the modal
    // bridge — currently the app-tools registration. Inline state
    // mutations (setIsReady, setReinitCount, display-mode publish,
    // etc.) intentionally stay skipped: the modal has its own
    // lifecycle and must not steer the inline renderer's React state.
    bridge.oninitialized = () => {
      // Send tool input/output to the modal bridge after initialization
      const resolvedToolInput = toolInputRef.current ?? {};
      bridge.sendToolInput({ arguments: resolvedToolInput });
      if (toolOutputRef.current) {
        bridge.sendToolResult(toolOutputRef.current as CallToolResult);
      }

      const appCaps = bridge.getAppCapabilities();
      // Record the advertised bit before the registration branch so the
      // policy re-enable effect can repopulate the registry after a
      // mid-session toggle without waiting for a fresh handshake.
      modalAppAdvertisedToolsRef.current = Boolean(appCaps?.tools);
      if (appCaps?.tools) {
        const bridgeId =
          modalAppToolsBridgeIdRef.current ?? crypto.randomUUID();
        modalAppToolsBridgeIdRef.current = bridgeId;
        void refreshAppProvidedTools(bridge, bridgeId, {
          surface: "modal",
          getIframeElement: () =>
            modalSandboxRef.current?.getIframeElement() ?? null,
          isLive: () => modalAppToolsBridgeIdRef.current === bridgeId,
        });
      }
    };

    modalBridgeRef.current = bridge;
    const pendingRpcMethods = new Map<string | number, string>();

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          const request = message as { id?: string | number; method?: string };
          if (
            typeof request.method === "string" &&
            (typeof request.id === "string" || typeof request.id === "number")
          ) {
            pendingRpcMethods.set(request.id, request.method);
          }
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
          const response = message as {
            id?: string | number;
            result?: unknown;
            error?: unknown;
          };
          const correlatedMethod =
            (response.result !== undefined || response.error !== undefined) &&
            (typeof response.id === "string" || typeof response.id === "number")
              ? pendingRpcMethods.get(response.id)
              : undefined;
          if (correlatedMethod && response.id !== undefined) {
            pendingRpcMethods.delete(response.id);
          }
          const method =
            correlatedMethod ?? extractMethod(message, "mcp-apps");
          // SEP-1865 App-Provided Tools: re-list when the modal app
          // signals a tools-list change. Mirrors the inline renderer's
          // `onReceive` hook so a `tool.update()` / `enable()` /
          // `disable()` from the modal app is reflected in the chat
          // snapshot's advertised aliases.
          if (method === "notifications/tools/list_changed") {
            const bridgeId = modalAppToolsBridgeIdRef.current;
            if (bridgeId) {
              void refreshAppProvidedTools(bridge, bridgeId, {
                force: true,
                surface: "modal",
                getIframeElement: () =>
                  modalSandboxRef.current?.getIframeElement() ?? null,
                isLive: () => modalAppToolsBridgeIdRef.current === bridgeId,
              });
            }
          }
          addUiLog({
            widgetId: `${toolCallId}-modal`,
            serverId,
            direction: "ui-to-host",
            protocol: "mcp-apps",
            method,
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
      // Reset the advertised gate so the policy effect can't act on a
      // stale handshake before the next bridge wires up.
      modalAppAdvertisedToolsRef.current = false;
      // SEP-1865 App-Provided Tools: unregister on effect teardown
      // (component unmount or modalHtml refetch). Clearing the ref
      // first ensures any in-flight `listTools` short-circuits via
      // `isLive` and doesn't re-register after we've torn down.
      if (modalAppToolsBridgeIdRef.current) {
        const bridgeId = modalAppToolsBridgeIdRef.current;
        modalAppToolsBridgeIdRef.current = null;
        useAppToolsRegistry.getState().unregisterInstance(bridgeId);
      }
      bridge.close().catch(() => {});
    };
  }, [
    modalHtml,
    open,
    addUiLog,
    serverId,
    toolCallId,
    registerBridgeHandlers,
    refreshAppProvidedTools,
    widgetPermissive,
    widgetCsp,
    widgetPermissions,
    hostContextRef,
    toolInputRef,
    toolOutputRef,
    activeMcpProfile,
    effectiveHostCapabilities,
  ]);

  // SEP-1865 App-Provided Tools: modal-side policy enforcement.
  // Mirrors the inline renderer's effect — the host policy lives outside
  // the bridge lifecycle, so a mid-session toggle cannot rely on the
  // bridge rebuilding to (un)register. While the modal is open, this
  // keeps `useAppToolsRegistry` in sync with the policy independently of
  // the inline surface.
  //
  //  Policy → false: unregister, clear the bridge id so any in-flight
  //                  `listTools` short-circuits via `isLive`.
  //  Policy → true:  if the modal's guest already advertised `tools`
  //                  and the bridge is live, mint a new id and call
  //                  `refreshAppProvidedTools` with `surface: "modal"`.
  useEffect(() => {
    if (!appToolsPolicyEnabled) {
      const bridgeId = modalAppToolsBridgeIdRef.current;
      if (!bridgeId) return;
      modalAppToolsBridgeIdRef.current = null;
      useAppToolsRegistry.getState().unregisterInstance(bridgeId);
      return;
    }
    if (modalAppToolsBridgeIdRef.current) return;
    const bridge = modalBridgeRef.current;
    if (!bridge) return;
    if (!modalAppAdvertisedToolsRef.current) return;
    const bridgeId = crypto.randomUUID();
    modalAppToolsBridgeIdRef.current = bridgeId;
    void refreshAppProvidedTools(bridge, bridgeId, {
      surface: "modal",
      getIframeElement: () =>
        modalSandboxRef.current?.getIframeElement() ?? null,
      isLive: () => modalAppToolsBridgeIdRef.current === bridgeId,
    });
  }, [appToolsPolicyEnabled, refreshAppProvidedTools]);

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
