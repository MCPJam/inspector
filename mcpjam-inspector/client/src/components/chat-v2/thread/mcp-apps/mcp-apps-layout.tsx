import type { CSSProperties, ReactNode, RefObject } from "react";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  type SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DisplayMode, ToolState } from "./mcp-apps-types";

interface McpAppsLayoutProps {
  toolState?: ToolState;
  loadError: string | null;
  widgetHtml: string | null;
  showWidget: boolean;
  effectiveDisplayMode: DisplayMode;
  isPlaygroundActive: boolean;
  playgroundDeviceType: "desktop" | "mobile" | "tablet" | "custom";
  toolName: string;
  toolCallId: string;
  pipWidgetId?: string | null;
  resourceUri: string;
  prefersBorder: boolean;
  iframeStyle: CSSProperties;
  sandboxRef: RefObject<SandboxedIframeHandle | null>;
  widgetCsp?: McpUiResourceCsp;
  widgetPermissions?: McpUiResourcePermissions;
  widgetPermissive: boolean;
  onSandboxMessage: (event: MessageEvent) => void;
  onSetDisplayMode: (mode: DisplayMode) => void;
  onExitPip?: (toolCallId: string) => void;
  modal: ReactNode;
}

export function McpAppsLayout({
  toolState,
  loadError,
  widgetHtml,
  showWidget,
  effectiveDisplayMode,
  isPlaygroundActive,
  playgroundDeviceType,
  toolName,
  toolCallId,
  pipWidgetId,
  resourceUri,
  prefersBorder,
  iframeStyle,
  sandboxRef,
  widgetCsp,
  widgetPermissions,
  widgetPermissive,
  onSandboxMessage,
  onSetDisplayMode,
  onExitPip,
  modal,
}: McpAppsLayoutProps) {
  if (toolState === "output-denied") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Tool execution was denied.
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load MCP App: {loadError}
      </div>
    );
  }

  if (!widgetHtml) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Preparing MCP App widget...
      </div>
    );
  }

  const isPip = effectiveDisplayMode === "pip";
  const isFullscreen = effectiveDisplayMode === "fullscreen";
  const isMobilePlaygroundMode =
    isPlaygroundActive && playgroundDeviceType === "mobile";
  const isContainedFullscreenMode =
    isPlaygroundActive &&
    (playgroundDeviceType === "mobile" || playgroundDeviceType === "tablet");

  const containerClassName = (() => {
    if (isFullscreen) {
      if (isContainedFullscreenMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      return "fixed inset-0 z-40 w-full h-full bg-background flex flex-col";
    }

    if (isPip) {
      if (isMobilePlaygroundMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      return [
        "fixed top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "shadow-xl border border-border/60 rounded-xl p-3",
      ].join(" ");
    }

    return "mt-3 space-y-2 relative group";
  })();

  return (
    <div className={containerClassName}>
      {!showWidget && (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          {toolState === "input-streaming"
            ? "Streaming tool arguments..."
            : "Preparing MCP App widget..."}
        </div>
      )}

      {((isFullscreen && isContainedFullscreenMode) ||
        (isPip && isMobilePlaygroundMode)) && (
        <button
          onClick={() => {
            onSetDisplayMode("inline");
            if (isPip) {
              onExitPip?.(toolCallId);
            }
          }}
          className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/20 hover:bg-black/40 text-white transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {isFullscreen && !isContainedFullscreenMode && (
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/40 bg-background/95 backdrop-blur z-40 shrink-0">
          <div />
          <div className="font-medium text-sm text-muted-foreground">
            {toolName}
          </div>
          <button
            onClick={() => {
              onSetDisplayMode("inline");
              if (pipWidgetId === toolCallId) {
                onExitPip?.(toolCallId);
              }
            }}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Exit fullscreen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {isPip && !isMobilePlaygroundMode && (
        <button
          onClick={() => {
            onSetDisplayMode("inline");
            onExitPip?.(toolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close PiP mode"
          title="Close PiP mode"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      <SandboxedIframe
        ref={sandboxRef}
        html={widgetHtml}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        csp={widgetCsp}
        permissions={widgetPermissions}
        permissive={widgetPermissive}
        onMessage={onSandboxMessage}
        title={`MCP App: ${toolName}`}
        className={`bg-background overflow-hidden ${
          isFullscreen
            ? "flex-1 border-0 rounded-none"
            : `rounded-md ${prefersBorder ? "border border-border/40" : ""}`
        }`}
        style={iframeStyle}
      />

      <div className="text-[11px] text-muted-foreground/70">
        MCP App: <code>{resourceUri}</code>
      </div>

      {modal}
    </div>
  );
}
