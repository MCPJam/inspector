import { useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  Database,
  Maximize2,
  MessageCircle,
  PictureInPicture2,
  Shield,
} from "lucide-react";
import { UITools, ToolUIPart, DynamicToolUIPart } from "ai";

import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  getToolNameFromType,
  getToolStateMeta,
  type ToolState,
  isDynamicTool,
} from "../thread-helpers";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { CspDebugPanel } from "../csp-debug-panel";
import { JsonEditor } from "@/components/ui/json-editor";

export function ToolPart({
  part,
  uiType,
  displayMode,
  pipWidgetId,
  fullscreenWidgetId,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestPip,
  onExitPip,
}: {
  part: ToolUIPart<UITools> | DynamicToolUIPart;
  uiType?: UIType | null;
  displayMode?: DisplayMode;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
}) {
  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

  const toolCallId = (part as any).toolCallId as string | undefined;
  const state = part.state as ToolState | undefined;
  const toolState = getToolStateMeta(state);
  const StatusIcon = toolState?.Icon;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpIconClassName =
    themeMode === "dark" ? "h-3 w-3 filter invert" : "h-3 w-3";
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeDebugTab, setActiveDebugTab] = useState<
    "data" | "state" | "csp" | "context" | null
  >("data");

  const inputData = (part as any).input;
  const outputData = (part as any).output;
  const errorText = (part as any).errorText ?? (part as any).error;
  const hasInput = inputData !== undefined && inputData !== null;
  const hasOutput = outputData !== undefined && outputData !== null;
  const hasError = state === "output-error" && !!errorText;

  const widgetDebugInfo = useWidgetDebugStore((s) =>
    toolCallId ? s.widgets.get(toolCallId) : undefined,
  );
  const hasWidgetDebug = !!widgetDebugInfo;

  const showDisplayModeControls =
    displayMode !== undefined &&
    onDisplayModeChange !== undefined &&
    hasWidgetDebug;

  const displayModeOptions: {
    mode: DisplayMode;
    icon: typeof MessageCircle;
    label: string;
  }[] = [
    { mode: "inline", icon: MessageCircle, label: "Inline" },
    { mode: "pip", icon: PictureInPicture2, label: "Picture in Picture" },
    { mode: "fullscreen", icon: Maximize2, label: "Fullscreen" },
  ];

  const debugOptions = useMemo(() => {
    const options: {
      tab: "data" | "state" | "csp" | "context";
      icon: typeof Database;
      label: string;
      badge?: number;
    }[] = [{ tab: "data", icon: Database, label: "Data" }];

    if (uiType === UIType.OPENAI_SDK) {
      options.push({ tab: "state", icon: Box, label: "Widget State" });
    }

    // Add model context tab for MCP Apps
    if (uiType === UIType.MCP_APPS && widgetDebugInfo?.modelContext) {
      options.push({
        tab: "context",
        icon: MessageCircle,
        label: "Model Context",
      });
    }

    options.push({
      tab: "csp",
      icon: Shield,
      label: "CSP",
      badge: widgetDebugInfo?.csp?.violations?.length,
    });

    return options;
  }, [
    uiType,
    widgetDebugInfo?.csp?.violations?.length,
    widgetDebugInfo?.modelContext,
  ]);

  const handleDebugClick = (tab: "data" | "state" | "csp" | "context") => {
    if (activeDebugTab === tab) {
      setActiveDebugTab(null);
      setIsExpanded(false);
    } else {
      setActiveDebugTab(tab);
      setIsExpanded(true);
    }
  };

  const handleDisplayModeChange = (mode: DisplayMode) => {
    if (toolCallId) {
      const exitPipTarget = pipWidgetId ?? toolCallId;
      const exitFullscreenTarget = fullscreenWidgetId ?? toolCallId;

      if (displayMode === "fullscreen" && mode !== "fullscreen") {
        onExitFullscreen?.(exitFullscreenTarget);
      } else if (displayMode === "pip" && mode !== "pip") {
        onExitPip?.(exitPipTarget);
      }

      if (mode === "fullscreen") {
        onRequestFullscreen?.(toolCallId);
      } else if (mode === "pip") {
        onRequestPip?.(toolCallId);
      }
    }

    onDisplayModeChange?.(mode);
  };

  return (
    <div className="rounded-lg border border-border/50 bg-background/70 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
      >
        <span className="inline-flex items-center gap-2 font-medium normal-case text-foreground min-w-0">
          <span className="inline-flex items-center gap-2 min-w-0">
            <img
              src="/mcp.svg"
              alt=""
              role="presentation"
              aria-hidden="true"
              className={`${mcpIconClassName} shrink-0`}
            />
            <span className="font-mono text-xs tracking-tight text-muted-foreground/80 truncate">
              {label}
            </span>
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground shrink-0">
          {showDisplayModeControls && (
            <span
              className="inline-flex items-center gap-0.5 border border-border/40 rounded-md p-0.5 bg-muted/30"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="inline-flex items-center gap-0.5">
                {displayModeOptions.map(({ mode, icon: Icon, label }) => {
                  const isActive = displayMode === mode;
                  return (
                    <Tooltip key={mode}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDisplayModeChange(mode);
                          }}
                          className={`p-1 rounded transition-colors cursor-pointer ${
                            isActive
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </span>
          )}
          {hasWidgetDebug && (
            <>
              {showDisplayModeControls && hasWidgetDebug && (
                <div className="h-4 w-px bg-border/40" />
              )}
              <span
                className="inline-flex items-center gap-0.5 border border-border/40 rounded-md p-0.5 bg-muted/30"
                onClick={(e) => e.stopPropagation()}
              >
                {debugOptions.map(({ tab, icon: Icon, label, badge }) => (
                  <Tooltip key={tab}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDebugClick(tab);
                        }}
                        className={`p-1 rounded transition-colors cursor-pointer relative ${
                          activeDebugTab === tab
                            ? "bg-background text-foreground shadow-sm"
                            : badge && badge > 0
                              ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                              : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {badge !== undefined && badge > 0 && (
                          <Badge
                            variant="destructive"
                            className="absolute -top-1.5 -right-1.5 h-3.5 min-w-[14px] px-1 text-[8px] leading-none"
                          >
                            {badge}
                          </Badge>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                ))}
              </span>
            </>
          )}
          {toolState && StatusIcon && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center"
              title={toolState.label}
            >
              <StatusIcon className={toolState.className} />
              <span className="sr-only">{toolState.label}</span>
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-150 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border/40 px-3 py-3">
          {hasWidgetDebug && activeDebugTab === "data" && (
            <div className="space-y-4">
              {hasInput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Input
                  </div>
                  <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                    <JsonEditor
                      viewOnly
                      value={inputData}
                      className="p-2 text-[11px]"
                      collapsible
                      defaultExpandDepth={2}
                    />
                  </div>
                </div>
              )}
              {hasOutput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Result
                  </div>
                  <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                    <JsonEditor
                      viewOnly
                      value={outputData}
                      className="p-2 text-[11px]"
                      collapsible
                      defaultExpandDepth={2}
                    />
                  </div>
                </div>
              )}
              {hasError && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Error
                  </div>
                  <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                    {errorText}
                  </div>
                </div>
              )}
              {!hasInput && !hasOutput && !hasError && (
                <div className="text-muted-foreground/70">
                  No tool details available.
                </div>
              )}
            </div>
          )}
          {hasWidgetDebug && activeDebugTab === "state" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Widget State
                </div>
                <div className="text-[9px] text-muted-foreground/50">
                  Updated:{" "}
                  {new Date(widgetDebugInfo.updatedAt).toLocaleTimeString()}
                </div>
              </div>
              <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                {widgetDebugInfo.widgetState ? (
                  <JsonEditor
                    viewOnly
                    value={widgetDebugInfo.widgetState}
                    className="p-2 text-[11px]"
                    collapsible
                    defaultExpandDepth={2}
                  />
                ) : (
                  <div className="p-2 text-[11px] text-muted-foreground">
                    null (no state set)
                  </div>
                )}
              </div>
              <div className="text-[9px] text-muted-foreground/50 mt-2">
                Tip: Widget state persists across follow-up turns. Keep under 4k
                tokens.
              </div>
            </div>
          )}
          {hasWidgetDebug && activeDebugTab === "csp" && (
            <CspDebugPanel
              cspInfo={widgetDebugInfo.csp}
              protocol={widgetDebugInfo.protocol}
            />
          )}
          {hasWidgetDebug && activeDebugTab === "context" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Model Context
                </div>
                {widgetDebugInfo.modelContext && (
                  <div className="text-[9px] text-muted-foreground/50">
                    Updated:{" "}
                    {new Date(
                      widgetDebugInfo.modelContext.updatedAt,
                    ).toLocaleTimeString()}
                  </div>
                )}
              </div>

              {widgetDebugInfo.modelContext ? (
                <div className="space-y-3">
                  {widgetDebugInfo.modelContext.content && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-medium text-muted-foreground">
                        Content (for model)
                      </div>
                      <div className="rounded-md border border-border/30 bg-muted/20 max-h-[200px] overflow-auto">
                        <JsonEditor
                          viewOnly
                          value={widgetDebugInfo.modelContext.content}
                          className="p-2 text-[11px]"
                          collapsible
                          defaultExpandDepth={2}
                        />
                      </div>
                    </div>
                  )}

                  {widgetDebugInfo.modelContext.structuredContent && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-medium text-muted-foreground">
                        Structured Content
                      </div>
                      <div className="rounded-md border border-border/30 bg-muted/20 max-h-[200px] overflow-auto">
                        <JsonEditor
                          viewOnly
                          value={widgetDebugInfo.modelContext.structuredContent}
                          className="p-2 text-[11px]"
                          collapsible
                          defaultExpandDepth={2}
                        />
                      </div>
                    </div>
                  )}

                  <div className="text-[9px] text-muted-foreground/50 mt-2">
                    This context will be included in future turns with the
                    model. Each update overwrites the previous context from this
                    widget.
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground/70 text-[11px]">
                  No model context set by this widget.
                </div>
              )}
            </div>
          )}
          {!hasWidgetDebug && (
            <div className="space-y-4">
              {hasInput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Input
                  </div>
                  <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                    <JsonEditor
                      viewOnly
                      value={inputData}
                      className="p-2 text-[11px]"
                      collapsible
                      defaultExpandDepth={2}
                    />
                  </div>
                </div>
              )}

              {hasOutput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Result
                  </div>
                  <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                    <JsonEditor
                      viewOnly
                      value={outputData}
                      className="p-2 text-[11px]"
                      collapsible
                      defaultExpandDepth={2}
                    />
                  </div>
                </div>
              )}

              {hasError && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Error
                  </div>
                  <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                    {errorText}
                  </div>
                </div>
              )}

              {!hasInput && !hasOutput && !hasError && (
                <div className="text-muted-foreground/70">
                  No tool details available.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
