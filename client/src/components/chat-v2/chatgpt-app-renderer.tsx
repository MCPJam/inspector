import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { X, Loader2 } from "lucide-react";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { ChatGPTSandboxedIframe, ChatGPTSandboxedIframeHandle, ChatGPTWidgetCSP } from "@/components/ui/chatgpt-sandboxed-iframe";

type DisplayMode = "inline" | "pip" | "fullscreen";
type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error" | string;

interface ChatGPTAppRendererProps {
  serverId: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  toolInput?: Record<string, any> | null;
  toolOutput?: unknown;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (toolName: string, params: Record<string, any>, meta?: Record<string, any>) => Promise<any>;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
}

// ============================================================================
// Helper Hooks
// ============================================================================

function useResolvedToolData(toolCallId: string | undefined, toolName: string | undefined, toolInputProp: Record<string, any> | null | undefined, toolOutputProp: unknown, toolMetadata: Record<string, any> | undefined) {
  const resolvedToolCallId = useMemo(() => toolCallId ?? `${toolName || "chatgpt-app"}-${Date.now()}`, [toolCallId, toolName]);
  const outputTemplate = useMemo(() => toolMetadata?.["openai/outputTemplate"], [toolMetadata]);

  const structuredContent = useMemo(() => {
    if (toolOutputProp && typeof toolOutputProp === "object" && toolOutputProp !== null && "structuredContent" in toolOutputProp) {
      return (toolOutputProp as Record<string, unknown>).structuredContent;
    }
    return null;
  }, [toolOutputProp]);

  const toolResponseMetadata = useMemo(() => {
    if (toolOutputProp && typeof toolOutputProp === "object" && toolOutputProp !== null) {
      if ("_meta" in toolOutputProp) return (toolOutputProp as Record<string, unknown>)._meta;
      if ("meta" in toolOutputProp) return (toolOutputProp as Record<string, unknown>).meta;
    }
    return null;
  }, [toolOutputProp]);

  const resolvedToolInput = useMemo(() => (toolInputProp as Record<string, any>) ?? {}, [toolInputProp]);
  const resolvedToolOutput = useMemo(() => structuredContent ?? toolOutputProp ?? null, [structuredContent, toolOutputProp]);

  return { resolvedToolCallId, outputTemplate, toolResponseMetadata, resolvedToolInput, resolvedToolOutput };
}

function useWidgetFetch(toolState: ToolState | undefined, resolvedToolCallId: string, outputTemplate: string | undefined, toolName: string | undefined, serverId: string, resolvedToolInput: Record<string, any>, resolvedToolOutput: unknown, toolResponseMetadata: unknown, themeMode: string) {
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<ChatGPTWidgetCSP | undefined>(undefined);
  const [widgetClosed, setWidgetClosed] = useState(false);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [modalUrl, setModalUrl] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    if (toolState !== "output-available" || widgetHtml || !outputTemplate || !toolName) {
      if (!outputTemplate) { setWidgetHtml(null); setStoreError(null); setIsStoringWidget(false); }
      if (!toolName && outputTemplate) { setWidgetHtml(null); setStoreError("Tool name is required"); setIsStoringWidget(false); }
      return;
    }

    const fetchWidgetHtml = async () => {
      setIsStoringWidget(true);
      setStoreError(null);
      try {
        const storeResponse = await fetch("/api/mcp/openai/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId, uri: outputTemplate, toolInput: resolvedToolInput, toolOutput: resolvedToolOutput, toolResponseMetadata, toolId: resolvedToolCallId, toolName, theme: themeMode }),
        });
        if (!storeResponse.ok) throw new Error(`Failed to store widget data: ${storeResponse.statusText}`);
        if (isCancelled) return;

        const htmlResponse = await fetch(`/api/mcp/openai/widget-html/${resolvedToolCallId}`);
        if (!htmlResponse.ok) {
          const errorData = await htmlResponse.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to fetch widget HTML: ${htmlResponse.statusText}`);
        }
        const data = await htmlResponse.json();
        if (isCancelled) return;

        if (data.closeWidget) { setWidgetClosed(true); setIsStoringWidget(false); return; }
        setWidgetHtml(data.html);
        setWidgetCsp(data.csp);
        setModalUrl(`/api/mcp/openai/widget/${resolvedToolCallId}`);
      } catch (err) {
        if (isCancelled) return;
        console.error("Error fetching widget HTML:", err);
        setStoreError(err instanceof Error ? err.message : "Failed to prepare widget");
      } finally {
        if (!isCancelled) setIsStoringWidget(false);
      }
    };
    fetchWidgetHtml();
    return () => { isCancelled = true; };
  }, [toolState, resolvedToolCallId, widgetHtml, outputTemplate, toolName, serverId, resolvedToolInput, resolvedToolOutput, toolResponseMetadata, themeMode]);

  return { widgetHtml, widgetCsp, widgetClosed, isStoringWidget, storeError, modalUrl };
}

// ============================================================================
// Main Component
// ============================================================================

export function ChatGPTAppRenderer({ serverId, toolCallId, toolName, toolState, toolInput: toolInputProp, toolOutput: toolOutputProp, toolMetadata, onSendFollowUp, onCallTool, onWidgetStateChange, pipWidgetId, onRequestPip, onExitPip }: ChatGPTAppRendererProps) {
  const sandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const modalIframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, any>>({});
  const [modalTitle, setModalTitle] = useState<string>("");
  const previousWidgetStateRef = useRef<string | null>(null);

  const { resolvedToolCallId, outputTemplate, toolResponseMetadata, resolvedToolInput, resolvedToolOutput } = useResolvedToolData(toolCallId, toolName, toolInputProp, toolOutputProp, toolMetadata);
  const { widgetHtml, widgetCsp, widgetClosed, isStoringWidget, storeError, modalUrl } = useWidgetFetch(toolState, resolvedToolCallId, outputTemplate, toolName, serverId, resolvedToolInput, resolvedToolOutput, toolResponseMetadata, themeMode);

  const appliedHeight = useMemo(() => {
    const baseHeight = contentHeight > 0 ? contentHeight : 320;
    return typeof maxHeight === "number" && Number.isFinite(maxHeight) ? Math.min(baseHeight, maxHeight) : baseHeight;
  }, [contentHeight, maxHeight]);

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "100%";
    if (displayMode === "pip") return pipWidgetId === resolvedToolCallId ? "400px" : `${appliedHeight}px`;
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode, pipWidgetId, resolvedToolCallId]);

  const addUiLog = useUiLogStore((s) => s.addLog);
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetState = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);

  useEffect(() => {
    if (!toolName) return;
    setWidgetDebugInfo(resolvedToolCallId, {
      toolName, protocol: "openai-apps", widgetState: null,
      globals: { theme: themeMode, displayMode, maxHeight: maxHeight ?? undefined, locale: "en-US", safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } }, userAgent: { device: { type: "desktop" }, capabilities: { hover: true, touch: false } } },
    });
  }, [resolvedToolCallId, toolName, setWidgetDebugInfo, themeMode, displayMode, maxHeight]);

  useEffect(() => {
    setWidgetGlobals(resolvedToolCallId, { theme: themeMode, displayMode, maxHeight: maxHeight ?? undefined });
  }, [resolvedToolCallId, themeMode, displayMode, maxHeight, setWidgetGlobals]);

  const postToWidget = useCallback((data: unknown, targetModal?: boolean) => {
    addUiLog({ widgetId: resolvedToolCallId, serverId, direction: "host-to-ui", protocol: "openai-apps", method: extractMethod(data, "openai-apps"), message: data });
    if (targetModal && modalIframeRef.current?.contentWindow) modalIframeRef.current.contentWindow.postMessage(data, "*");
    else sandboxRef.current?.postMessage(data);
  }, [addUiLog, resolvedToolCallId, serverId]);

  const handleSandboxMessage = useCallback(async (event: MessageEvent) => {
    if (event.data?.type) addUiLog({ widgetId: resolvedToolCallId, serverId, direction: "ui-to-host", protocol: "openai-apps", method: extractMethod(event.data, "openai-apps"), message: event.data });

    switch (event.data?.type) {
      case "openai:resize": {
        const rawHeight = Number(event.data.height);
        if (Number.isFinite(rawHeight) && rawHeight > 0) setContentHeight((prev) => Math.abs(prev - Math.round(rawHeight)) > 1 ? Math.round(rawHeight) : prev);
        break;
      }
      case "openai:setWidgetState": {
        if (event.data.toolId === resolvedToolCallId) {
          const newState = event.data.state;
          const newStateStr = newState === null ? null : JSON.stringify(newState);
          if (newStateStr !== previousWidgetStateRef.current) {
            previousWidgetStateRef.current = newStateStr;
            setWidgetState(resolvedToolCallId, newState);
            onWidgetStateChange?.(resolvedToolCallId, newState);
          }
        }
        if (modalOpen) postToWidget({ type: "openai:pushWidgetState", toolId: resolvedToolCallId, state: event.data.state }, true);
        break;
      }
      case "openai:callTool": {
        const callId = event.data.callId;
        if (!onCallTool) { postToWidget({ type: "openai:callTool:response", callId, error: "callTool is not supported in this context" }); break; }
        try {
          const result = await onCallTool(event.data.toolName, event.data.args || event.data.params || {}, event.data._meta || {});
          postToWidget({ type: "openai:callTool:response", callId, result });
        } catch (err) { postToWidget({ type: "openai:callTool:response", callId, error: err instanceof Error ? err.message : "Unknown error" }); }
        break;
      }
      case "openai:sendFollowup": {
        if (onSendFollowUp && event.data.message) {
          const message = typeof event.data.message === "string" ? event.data.message : event.data.message.prompt || JSON.stringify(event.data.message);
          onSendFollowUp(message);
        }
        break;
      }
      case "openai:requestDisplayMode": {
        const requestedMode = event.data.mode || "inline";
        const isMobile = window.innerWidth < 768;
        const actualMode = isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;
        setDisplayMode(actualMode);
        if (actualMode === "pip") onRequestPip?.(resolvedToolCallId);
        else if ((actualMode === "inline" || actualMode === "fullscreen") && pipWidgetId === resolvedToolCallId) onExitPip?.(resolvedToolCallId);
        if (typeof event.data.maxHeight === "number") setMaxHeight(event.data.maxHeight);
        else if (event.data.maxHeight == null) setMaxHeight(null);
        postToWidget({ type: "openai:set_globals", globals: { displayMode: actualMode } });
        break;
      }
      case "openai:requestClose": {
        setDisplayMode("inline");
        if (pipWidgetId === resolvedToolCallId) onExitPip?.(resolvedToolCallId);
        break;
      }
      case "openai:csp-violation": {
        const { directive, blockedUri, sourceFile, lineNumber } = event.data;
        console.warn(`[ChatGPT Widget CSP] Blocked ${blockedUri} by ${directive}`, sourceFile ? `at ${sourceFile}:${lineNumber}` : "");
        break;
      }
      case "openai:openExternal": {
        if (event.data.href && typeof event.data.href === "string") {
          const href = event.data.href;
          if (href.startsWith("http://localhost") || href.startsWith("http://127.0.0.1")) break;
          window.open(href, "_blank", "noopener,noreferrer");
        }
        break;
      }
      case "openai:requestModal": {
        setModalTitle(event.data.title || "Modal");
        setModalParams(event.data.params || {});
        setModalOpen(true);
        break;
      }
    }
  }, [onCallTool, onSendFollowUp, onWidgetStateChange, resolvedToolCallId, pipWidgetId, modalOpen, onRequestPip, onExitPip, addUiLog, postToWidget, serverId, setWidgetState]);

  const handleModalMessage = useCallback(async (event: MessageEvent) => {
    const modalWindow = modalIframeRef.current?.contentWindow ?? null;
    if (!modalWindow || event.source !== modalWindow) return;
    if (event.data?.type) addUiLog({ widgetId: resolvedToolCallId, serverId, direction: "ui-to-host", protocol: "openai-apps", method: extractMethod(event.data, "openai-apps"), message: event.data });
    if (event.data?.type === "openai:setWidgetState" && event.data.toolId === resolvedToolCallId) {
      const newState = event.data.state;
      setWidgetState(resolvedToolCallId, newState);
      onWidgetStateChange?.(resolvedToolCallId, newState);
      postToWidget({ type: "openai:pushWidgetState", toolId: resolvedToolCallId, state: newState });
    }
  }, [addUiLog, resolvedToolCallId, serverId, setWidgetState, onWidgetStateChange, postToWidget]);

  useEffect(() => { window.addEventListener("message", handleModalMessage); return () => window.removeEventListener("message", handleModalMessage); }, [handleModalMessage]);
  useEffect(() => { if (displayMode === "pip" && pipWidgetId !== resolvedToolCallId) setDisplayMode("inline"); }, [displayMode, pipWidgetId, resolvedToolCallId]);

  useEffect(() => {
    if (!isReady) return;
    const globals: Record<string, unknown> = { theme: themeMode, displayMode };
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) globals.maxHeight = maxHeight;
    postToWidget({ type: "openai:set_globals", globals });
    if (modalOpen) postToWidget({ type: "openai:set_globals", globals }, true);
  }, [themeMode, maxHeight, displayMode, isReady, modalOpen, postToWidget]);

  const invokingText = toolMetadata?.["openai/toolInvocation/invoking"] as string | undefined;
  const invokedText = toolMetadata?.["openai/toolInvocation/invoked"] as string | undefined;

  // Loading/error states
  if (toolState === "input-streaming" || toolState === "input-available") {
    return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />{invokingText || "Executing tool..."}</div>;
  }
  if (isStoringWidget) return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Loading ChatGPT App widget...</div>;
  if (storeError) return <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">Failed to load widget: {storeError}{outputTemplate && <> (Template <code>{outputTemplate}</code>)</>}</div>;
  if (widgetClosed) return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">{invokedText || "Tool completed successfully."}</div>;
  if (!outputTemplate) {
    if (toolState !== "output-available") return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">Widget UI will appear once the tool finishes executing.</div>;
    return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">Unable to render ChatGPT App UI for this tool result.</div>;
  }
  if (!widgetHtml) return <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Preparing widget...</div>;

  const isPip = displayMode === "pip" && pipWidgetId === resolvedToolCallId;
  const isFullscreen = displayMode === "fullscreen";
  const containerClassName = isFullscreen
    ? "fixed inset-0 z-50 w-full h-full bg-background flex flex-col"
    : isPip
    ? "fixed top-4 inset-x-0 z-40 w-full max-w-4xl mx-auto space-y-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-xl border border-border/60 rounded-xl p-3"
    : "mt-3 space-y-2 relative group";

  return (
    <div className={containerClassName}>
      {(isPip || isFullscreen) && (
        <button onClick={() => { setDisplayMode("inline"); onExitPip?.(resolvedToolCallId); }} className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" aria-label="Close PiP mode" title="Close PiP mode">
          <X className="w-4 h-4" />
        </button>
      )}
      {loadError && <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">Failed to load widget: {loadError}</div>}
      <ChatGPTSandboxedIframe ref={sandboxRef} html={widgetHtml} csp={widgetCsp} onMessage={handleSandboxMessage} onReady={() => { setIsReady(true); setLoadError(null); }} title={`ChatGPT App Widget: ${toolName || "tool"}`} className="w-full border border-border/40 rounded-md bg-background" style={{ height: iframeHeight, maxHeight: displayMode === "fullscreen" ? "90vh" : undefined }} />
      {outputTemplate && <div className="text-[11px] text-muted-foreground/70">Template: <code>{outputTemplate}</code></div>}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-6xl h-[70vh] flex flex-col">
          <DialogHeader><DialogTitle>{modalTitle}</DialogTitle></DialogHeader>
          <div className="flex-1 w-full h-full min-h-0">
            <iframe ref={modalIframeRef} src={modalUrl ? `${modalUrl}?view_mode=modal&view_params=${encodeURIComponent(JSON.stringify(modalParams))}` : undefined} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" title={`ChatGPT App Modal: ${modalTitle}`} className="w-full h-full border-0 rounded-md bg-background" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
