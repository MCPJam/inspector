import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Check,
  ChevronDown,
  Database,
  Layers,
  Loader2,
  Maximize2,
  MessageCircle,
  PictureInPicture2,
  Shield,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import { UITools, ToolUIPart, DynamicToolUIPart } from "ai";

import { usePostHog } from "posthog-js/react";
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
import { Button } from "@/components/ui/button";
import { CspDebugPanel } from "../csp-debug-panel";
import { JsonEditor } from "@/components/ui/json-editor";
import { cn } from "@/lib/chat-utils";

type ApprovalVisualState = "pending" | "approved" | "denied";

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
  appSupportedDisplayModes,
  approvalId,
  onApprove,
  onDeny,
  onSaveView,
  canSaveView,
  saveDisabledReason,
  isSaving,
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
  /** Display modes the app declared support for. If undefined, all modes are available. */
  appSupportedDisplayModes?: DisplayMode[];
  approvalId?: string;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  /** Callback to save this tool execution as a view */
  onSaveView?: () => void;
  /** Whether the save view button should be enabled */
  canSaveView?: boolean;
  /** Reason why save is disabled (for tooltip) */
  saveDisabledReason?: string;
  /** Whether the view is currently being saved */
  isSaving?: boolean;
}) {
  const posthog = usePostHog();
  const hasTrackedSkillLoad = useRef(false);

  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

  const toolCallId = (part as any).toolCallId as string | undefined;
  const state = part.state as ToolState | undefined;

  useEffect(() => {
    const isUserInjected = toolCallId?.startsWith("skill-load-");
    if (
      !hasTrackedSkillLoad.current &&
      !isUserInjected &&
      label === "loadSkill" &&
      state === "output-available"
    ) {
      hasTrackedSkillLoad.current = true;
      posthog.capture("skill_loaded", {
        skill_name: (part as any).input?.name ?? "unknown",
      });
    }
  }, [state, label, posthog, toolCallId, part]);
  const toolState = getToolStateMeta(state);
  const StatusIcon = toolState?.Icon;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpIconClassName =
    themeMode === "dark" ? "h-3 w-3 filter invert" : "h-3 w-3";
  const needsApproval = state === "approval-requested" && !!approvalId;
  const [approvalVisualState, setApprovalVisualState] =
    useState<ApprovalVisualState>("pending");
  const isDenied =
    approvalVisualState === "denied" || state === "output-denied";
  const hideAppControls = isDenied || needsApproval;
  const [userExpanded, setUserExpanded] = useState(false);
  const isExpanded = needsApproval || userExpanded;
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
    hasWidgetDebug &&
    !hideAppControls;

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
      setUserExpanded(false);
    } else {
      setActiveDebugTab(tab);
      setUserExpanded(true);
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
    <div
      className={cn(
        "rounded-lg border text-xs",
        needsApproval && approvalVisualState === "pending"
          ? "border-pending/40 bg-pending/5"
          : needsApproval && approvalVisualState === "approved"
            ? "border-success/40 bg-success/5"
            : needsApproval && approvalVisualState === "denied"
              ? "border-destructive/40 bg-destructive/5"
              : "border-border/50 bg-background/70",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer"
        onClick={() => setUserExpanded((prev) => !prev)}
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
          {needsApproval && approvalVisualState === "pending" && (
            <span className="text-[11px] font-medium text-pending-foreground dark:text-pending">
              Approve tool call?
            </span>
          )}
          {needsApproval && approvalVisualState === "approved" && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-success dark:text-success">
              <ShieldCheck className="h-3.5 w-3.5" />
              Approved
            </span>
          )}
          {needsApproval && approvalVisualState === "denied" && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-destructive">
              <ShieldX className="h-3.5 w-3.5" />
              Denied
            </span>
          )}
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
                  const isDisabled =
                    appSupportedDisplayModes !== undefined &&
                    !appSupportedDisplayModes.includes(mode);
                  return (
                    <Tooltip key={mode}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={isDisabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isDisabled) return;
                            handleDisplayModeChange(mode);
                          }}
                          className={`p-1 rounded transition-colors ${
                            isDisabled
                              ? "text-muted-foreground/30 cursor-not-allowed"
                              : isActive
                                ? "bg-background text-foreground shadow-sm cursor-pointer"
                                : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50 cursor-pointer"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isDisabled
                          ? `${label} (not supported by this app)`
                          : label}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </span>
          )}
          {hasWidgetDebug && !hideAppControls && (
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
          {onSaveView && uiType && uiType !== UIType.MCP_UI && (
            <>
              {hasWidgetDebug && <div className="h-4 w-px bg-border/40" />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!canSaveView || isSaving}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSaveView();
                    }}
                    className={`p-1 rounded transition-colors ${
                      canSaveView && !isSaving
                        ? "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50 cursor-pointer"
                        : "text-muted-foreground/30 cursor-not-allowed"
                    }`}
                  >
                    {isSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Layers className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {isSaving
                    ? "Saving..."
                    : canSaveView
                      ? "Save as View"
                      : saveDisabledReason || "No output to save"}
                </TooltipContent>
              </Tooltip>
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
          {!needsApproval && (
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-150 ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          )}
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
                      height="100%"
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
                      height="100%"
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
                    height="100%"
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
                          height="100%"
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
                          height="100%"
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
                      height="100%"
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
                      height="100%"
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
          {needsApproval && approvalVisualState === "pending" && (
            <div className="flex items-center gap-2 pt-2 border-t border-border/40 mt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs border-success/40 text-success hover:bg-success/10"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!approvalId) return;
                  setApprovalVisualState("approved");
                  setUserExpanded(false);
                  onApprove?.(approvalId);
                }}
              >
                <Check className="h-3 w-3 mr-1" />
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!approvalId) return;
                  setApprovalVisualState("denied");
                  setUserExpanded(false);
                  onDeny?.(approvalId);
                }}
              >
                <X className="h-3 w-3 mr-1" />
                Deny
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
