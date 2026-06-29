import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  Box,
  Check,
  ChevronDown,
  Database,
  Loader2,
  Maximize2,
  MessageCircle,
  Pencil,
  PictureInPicture2,
  Play,
  RotateCcw,
  Shield,
  ShieldCheck,
  ShieldX,
  Terminal,
} from "lucide-react";
import { UITools, ToolUIPart, DynamicToolUIPart } from "ai";

import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { useAppToolAttribution } from "../mcp-apps/app-tools-registry";
import {
  getToolNameFromType,
  getToolStateMeta,
  type ToolState,
  isDynamicTool,
} from "../thread-helpers";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { CspWorkbench } from "../csp-workbench";
import { JsonEditor } from "@/components/ui/json-editor";
import { cn } from "@/lib/chat-utils";
import { filterSafeExternalLinkUrls } from "@/lib/safe-external-url";
import { TextPart } from "./text-part";
import { useHostContextStore } from "@/stores/client-context-store";
import { extractHostDisplayModes } from "@/lib/client-config";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

type ApprovalVisualState = "pending" | "approved" | "denied";
type TraceDisplayMode = "markdown" | "json-markdown";

export function ToolPart({
  part,
  chatSessionId,
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
  allowInlineEdit,
  isEditing,
  onToggleEdit,
  onInputChange,
  onOutputChange,
  inputValue,
  outputValue,
  hasEdits,
  onRevert,
  onRun,
  isRunning,
  canRun,
  editVersion,
  minimalMode = false,
}: {
  part: ToolUIPart<UITools> | DynamicToolUIPart;
  chatSessionId?: string;
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
  /** Whether the inline Edit affordance is available for this card. */
  allowInlineEdit?: boolean;
  /** Whether the input/output editors are currently editable. */
  isEditing?: boolean;
  /** Toggle edit mode on/off. */
  onToggleEdit?: () => void;
  /** Lift edited tool input (valid JSON only) to the parent. */
  onInputChange?: (value: unknown) => void;
  /** Lift edited tool output (valid JSON only) to the parent. */
  onOutputChange?: (value: unknown) => void;
  /** Effective input shown in the editor — exactly what the widget receives. */
  inputValue?: unknown;
  /** Effective output shown in the editor — exactly what the widget receives. */
  outputValue?: unknown;
  /** Whether there are uncommitted edits (enables Revert). */
  hasEdits?: boolean;
  /** Discard edits back to the original input/output. */
  onRevert?: () => void;
  /** Re-run the tool with the edited input (server round-trip). */
  onRun?: () => void;
  /** Whether a Run is in flight. */
  isRunning?: boolean;
  /** Whether Run is available (server connected). */
  canRun?: boolean;
  /** Bumped by the parent to remount + reseed the editors on a hard reset. */
  editVersion?: number;
  minimalMode?: boolean;
}) {
  const posthog = usePostHog();
  const hasTrackedSkillLoad = useRef(false);

  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

  // SEP-1865 App-Provided Tools: opaque `app_<hash>` aliases are resolved
  // through the shared app-tool registry/log helper so UI never leaks the
  // model-facing alias when a human-readable tool name is available.
  const appToolAttribution = useAppToolAttribution(label, chatSessionId);
  const displayLabel = appToolAttribution?.rawName ?? label;

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
        ...standardEventProps("chat_tool_part"),
      });
    }
  }, [state, label, posthog, toolCallId, part]);
  const toolState = getToolStateMeta(state);
  const StatusIcon = toolState?.Icon;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostTheme = useChatboxHostTheme();
  const resolvedThemeMode = chatboxHostTheme ?? themeMode;
  const mcpIconClassName =
    resolvedThemeMode === "dark" ? "h-3 w-3 filter invert" : "h-3 w-3";
  const needsApproval = state === "approval-requested" && !!approvalId;
  const [approvalVisualState, setApprovalVisualState] =
    useState<ApprovalVisualState>("pending");
  const isDenied =
    approvalVisualState === "denied" || state === "output-denied";
  const hideDiagnosticsUI = minimalMode;
  const hideAppControls = isDenied;
  const [userExpanded, setUserExpanded] = useState(false);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const isExpanded = !hideDiagnosticsUI && userExpanded;
  const [activeDebugTab, setActiveDebugTab] = useState<
    "data" | "state" | "sandbox" | "context" | null
  >("data");

  const inputData = (part as any).input;
  const outputData = (part as any).output;
  // Editors render the effective values (what the widget sees) when the parent
  // supplies them; fall back to the raw part data otherwise (non-widget branch).
  const editInputValue = inputValue !== undefined ? inputValue : inputData;
  const editOutputValue = outputValue !== undefined ? outputValue : outputData;
  const editorKeyVersion = editVersion ?? 0;
  const errorText = (part as any).errorText ?? (part as any).error;
  const traceDisplayText =
    typeof (part as unknown as { traceDisplayText?: unknown })
      .traceDisplayText === "string"
      ? (part as unknown as { traceDisplayText: string }).traceDisplayText
      : undefined;
  const traceDisplayMode = (part as { traceDisplayMode?: TraceDisplayMode })
    .traceDisplayMode;
  const hasAttachedTraceDisplay = Boolean(
    traceDisplayText &&
      (traceDisplayMode === "markdown" || traceDisplayMode === "json-markdown")
  );
  const hasInput = inputData !== undefined && inputData !== null;
  const paramCount = useMemo(() => {
    if (!hasInput) return 0;
    if (Array.isArray(inputData)) return inputData.length;
    if (typeof inputData === "object") {
      return Object.keys(inputData as Record<string, unknown>).length;
    }
    return 1;
  }, [hasInput, inputData]);
  const hasOutput = outputData !== undefined && outputData !== null;
  const hasError = state === "output-error" && !!errorText;
  const showRawResult = hasOutput && !hasAttachedTraceDisplay;

  const widgetDebugInfo = useWidgetDebugStore((s) =>
    toolCallId ? s.widgets.get(toolCallId) : undefined
  );
  const hostContext = useHostContextStore((s) => s.draftHostContext);
  const hostAvailableDisplayModes = useMemo(
    () => extractHostDisplayModes(hostContext),
    [hostContext]
  );
  const hasWidgetDebug = !!widgetDebugInfo;
  const hasWidgetDebugUI = !hideDiagnosticsUI && hasWidgetDebug;

  const showDisplayModeControls =
    displayMode !== undefined &&
    onDisplayModeChange !== undefined &&
    !hideAppControls;
  const showDebugControls = hasWidgetDebugUI && !hideAppControls;

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
      tab: "data" | "state" | "sandbox" | "context";
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
      tab: "sandbox",
      icon: Shield,
      label: "Sandbox",
      badge: widgetDebugInfo?.csp?.violations?.length,
    });

    return options;
  }, [
    uiType,
    widgetDebugInfo?.csp?.violations?.length,
    widgetDebugInfo?.modelContext,
  ]);

  const handleDebugClick = (tab: "data" | "state" | "sandbox" | "context") => {
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

  // Enter/exit inline edit. Always open the Data tab so the editors are visible.
  const handleEditClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onToggleEdit?.();
    setActiveDebugTab("data");
    setUserExpanded(true);
  };

  const renderDisplayModeOptionButtons = () =>
    displayModeOptions.map(({ mode, icon: Icon }) => {
      const isActive = displayMode === mode;
      const isDisabled =
        !hostAvailableDisplayModes.includes(mode) ||
        (appSupportedDisplayModes !== undefined &&
          !appSupportedDisplayModes.includes(mode));
      const buttonLabel =
        mode === "inline" ? "Inline" : mode === "pip" ? "PiP" : "Fullscreen";
      return (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={buttonLabel}
              disabled={isDisabled}
              onClick={(e) => {
                e.stopPropagation();
                if (isDisabled) return;
                handleDisplayModeChange(mode);
              }}
              className={`inline-flex items-center gap-1 px-1.5 py-1 rounded transition-colors ${
                isDisabled
                  ? "text-muted-foreground/30 cursor-not-allowed"
                  : isActive
                  ? "bg-background text-foreground shadow-sm cursor-pointer"
                  : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50 cursor-pointer"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="text-[9px] leading-none hidden @[33rem]:inline">
                {buttonLabel}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{buttonLabel}</p>
          </TooltipContent>
        </Tooltip>
      );
    });

  const renderDebugOptionButtons = () =>
    debugOptions.map(({ tab, icon: Icon, badge }) => {
      const buttonLabel =
        tab === "data"
          ? "Data"
          : tab === "state"
          ? "State"
          : tab === "sandbox"
          ? "Sandbox"
          : "Context";
      const tooltipLabel =
        tab === "data"
          ? "Data"
          : tab === "state"
          ? "Widget State"
          : tab === "sandbox"
          ? "Sandbox"
          : "Model Context";

      return (
        <Tooltip key={tab}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={tooltipLabel}
              onClick={(e) => {
                e.stopPropagation();
                handleDebugClick(tab);
              }}
              className={`inline-flex items-center gap-1 px-1.5 py-1 rounded transition-colors cursor-pointer relative ${
                activeDebugTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : badge && badge > 0
                  ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                  : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="text-[9px] leading-none hidden @[33rem]:inline">
                {buttonLabel}
              </span>
              {badge !== undefined && badge > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -top-1.5 -right-1.5 h-3.5 min-w-[14px] px-1 text-[8px] leading-none text-white"
                >
                  {badge}
                </Badge>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{tooltipLabel}</p>
          </TooltipContent>
        </Tooltip>
      );
    });

  const renderEditControls = () => (
    <span className="relative inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={isEditing ? "Done editing" : "Edit input and output"}
            onClick={handleEditClick}
            className={`inline-flex items-center gap-1 px-1.5 py-1 rounded border transition-colors cursor-pointer ${
              isEditing
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border/50 bg-background text-foreground shadow-sm hover:bg-background/80"
            }`}
          >
            {isEditing ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Pencil className="h-3.5 w-3.5" />
            )}
            <span className="text-[9px] leading-none hidden @[33rem]:inline">
              {isEditing ? "Done" : "Edit"}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-medium">
            {isEditing ? "Done editing" : "Edit input & output"}
          </p>
        </TooltipContent>
      </Tooltip>

      {isEditing && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Run tool with edited input"
                disabled={!canRun}
                onClick={(e) => {
                  e.stopPropagation();
                  if (canRun) onRun?.();
                }}
                className={`inline-flex items-center gap-1 px-1.5 py-1 rounded border transition-colors ${
                  canRun
                    ? "border-border/50 bg-background text-foreground shadow-sm hover:bg-background/80 cursor-pointer"
                    : "border-border/30 text-muted-foreground/30 cursor-not-allowed"
                }`}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                <span className="text-[9px] leading-none hidden @[33rem]:inline">
                  Run
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">
                {canRun
                  ? "Re-run tool with edited input"
                  : "Connect the server to run"}
              </p>
            </TooltipContent>
          </Tooltip>

          {hasEdits && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Revert edits"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRevert?.();
                  }}
                  className="inline-flex items-center gap-1 px-1.5 py-1 rounded border border-border/50 bg-background text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="text-[9px] leading-none hidden @[33rem]:inline">
                    Revert
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Revert edits</p>
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </span>
  );

  const toggleExpanded = () => {
    if (hideDiagnosticsUI) {
      return;
    }
    setUserExpanded((prev) => {
      const willExpand = !prev;
      if (willExpand && activeDebugTab === null) {
        setActiveDebugTab("data");
      }
      return willExpand;
    });
  };

  const handleHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  };

  const renderToolInput = () =>
    hasInput ? (
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Input
        </div>
        <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
          <JsonEditor
            key={`tool-input-${editorKeyVersion}`}
            height="100%"
            value={editInputValue}
            className="p-2 text-[11px]"
            collapsible
            defaultExpandDepth={2}
            {...(isEditing && !isRunning && onInputChange
              ? {
                  mode: "edit" as const,
                  onModeChange: () => {},
                  showModeToggle: false,
                  onChange: onInputChange,
                }
              : { viewOnly: true })}
          />
        </div>
      </div>
    ) : null;

  const renderAttachedTraceDisplay = () =>
    hasAttachedTraceDisplay && traceDisplayText ? (
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Result
        </div>
        <div
          data-testid="tool-part-readable-result"
          className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto px-3 py-2"
        >
          <TextPart text={traceDisplayText} role="assistant" />
        </div>
      </div>
    ) : null;

  const renderToolResult = () =>
    showRawResult ? (
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Result
        </div>
        <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
          <JsonEditor
            key={`tool-result-${editorKeyVersion}`}
            height="100%"
            value={editOutputValue}
            className="p-2 text-[11px]"
            collapsible
            defaultExpandDepth={2}
            {...(isEditing && !isRunning && onOutputChange
              ? {
                  mode: "edit" as const,
                  onModeChange: () => {},
                  showModeToggle: false,
                  onChange: onOutputChange,
                }
              : { viewOnly: true })}
          />
        </div>
      </div>
    ) : null;

  // Device-flow login URLs surfaced by the computer `bash` tool (e.g. from
  // `gh auth login`). The tool lifts them into a structured `authUrls` field
  // so the user can click instead of hunting through scrollback. Tool output
  // is UNTRUSTED, so each candidate is re-validated to a safe http(s) link
  // here — never render `javascript:`/`data:`/etc. as a clickable link.
  const renderAuthUrls = () => {
    const urls = filterSafeExternalLinkUrls(
      (outputData as { authUrls?: unknown })?.authUrls
    );
    if (urls.length === 0) return null;
    return (
      <div className="space-y-1" data-testid="tool-part-auth-urls">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Sign-in {urls.length > 1 ? "links" : "link"}
        </div>
        <ul className="space-y-1">
          {urls.map((url) => (
            <li key={url}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline underline-offset-2 break-all"
              >
                {url}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderToolError = () =>
    hasError ? (
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Error
        </div>
        <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
          {errorText}
        </div>
      </div>
    ) : null;

  const renderToolData = () => {
    if (!hasInput && !showRawResult && !hasError && !hasAttachedTraceDisplay) {
      return (
        <div className="text-muted-foreground/70">
          No tool details available.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {renderToolInput()}
        {renderAttachedTraceDisplay()}
        {renderAuthUrls()}
        {renderToolResult()}
        {renderToolError()}
      </div>
    );
  };

  if (needsApproval) {
    return (
      <div className="text-xs">
        <div className="flex flex-col gap-2 w-full">
          <div
            className={cn(
              "flex w-full items-center gap-3 pl-3.5 pr-1.5 py-1.5 rounded-full border",
              approvalVisualState === "approved"
                ? "border-success/40 bg-success/10"
                : approvalVisualState === "denied"
                ? "border-destructive/40 bg-destructive/10"
                : "border-border/60 bg-muted/30"
            )}
          >
            <span className="inline-flex items-center gap-1.5 text-muted-foreground text-[12px] shrink-0">
              <Terminal className="h-3 w-3" />
              <span>Run</span>
            </span>
            <span className="font-mono text-[13px] text-foreground truncate min-w-0">
              {displayLabel}
            </span>
            {appToolAttribution && (
              <span className="inline-flex items-center rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10.5px] text-muted-foreground shrink-0">
                from {appToolAttribution.appName}
              </span>
            )}

            {approvalVisualState === "pending" && (
              <>
                {paramCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setParamsExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer shrink-0"
                    aria-expanded={paramsExpanded}
                  >
                    {paramCount} parameter{paramCount === 1 ? "" : "s"}
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 transition-transform",
                        paramsExpanded && "rotate-180"
                      )}
                    />
                  </button>
                ) : (
                  <span className="px-2 text-[12px] text-muted-foreground/60 shrink-0">
                    no parameters
                  </span>
                )}
                <span className="ml-auto h-4 w-px bg-border/60 shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    if (!approvalId) return;
                    setApprovalVisualState("approved");
                    onApprove?.(approvalId);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground hover:brightness-110 transition cursor-pointer"
                >
                  <Check className="h-3 w-3" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!approvalId) return;
                    setApprovalVisualState("denied");
                    onDeny?.(approvalId);
                  }}
                  className="inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition cursor-pointer"
                >
                  Deny
                </button>
              </>
            )}

            {approvalVisualState === "approved" && (
              <span className="inline-flex items-center gap-1 px-2 text-[12px] font-medium text-success">
                <ShieldCheck className="h-3 w-3" />
                Approved
              </span>
            )}
            {approvalVisualState === "denied" && (
              <span className="inline-flex items-center gap-1 px-2 text-[12px] font-medium text-destructive">
                <ShieldX className="h-3 w-3" />
                Denied
              </span>
            )}
          </div>

          {paramsExpanded && hasInput && approvalVisualState === "pending" && (
            <div className="w-full rounded-lg border border-border/40 bg-muted/20 max-h-[300px] overflow-auto">
              <JsonEditor
                height="100%"
                viewOnly
                value={inputData}
                className="p-2 text-[11px]"
                collapsible
                defaultExpandDepth={2}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="@container rounded-lg border text-xs border-border/50 bg-background/70">
      <div
        role="button"
        tabIndex={hideDiagnosticsUI ? -1 : 0}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer"
        onClick={toggleExpanded}
        onKeyDown={handleHeaderKeyDown}
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
              {displayLabel}
            </span>
            {appToolAttribution && (
              <span className="inline-flex items-center rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground/80 shrink-0">
                from {appToolAttribution.appName}
              </span>
            )}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {showDisplayModeControls && (
            <span
              className="inline-flex items-center gap-0.5 border border-border/40 rounded-md p-0.5 bg-muted/30"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="inline-flex items-center gap-0.5">
                {renderDisplayModeOptionButtons()}
              </div>
            </span>
          )}
          {showDebugControls && (
            <>
              {showDisplayModeControls && (
                <div className="h-4 w-px bg-border/40" />
              )}
              <span
                className="inline-flex items-center gap-0.5 border border-border/40 rounded-md p-0.5 bg-muted/30"
                onClick={(e) => e.stopPropagation()}
              >
                {renderDebugOptionButtons()}
              </span>
            </>
          )}
          {!hideDiagnosticsUI && allowInlineEdit && (
            <>
              {hasWidgetDebugUI && <div className="h-4 w-px bg-border/40" />}
              {renderEditControls()}
            </>
          )}
          {toolState &&
            StatusIcon &&
            state !== "output-available" &&
            state !== "input-available" && (
              <span
                className="inline-flex h-5 w-5 items-center justify-center"
                title={toolState.label}
              >
                <StatusIcon className={toolState.className} />
                <span className="sr-only">{toolState.label}</span>
              </span>
            )}
          {!needsApproval && !hideDiagnosticsUI && (
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-150 ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          )}
        </span>
      </div>

      {isExpanded && (
        <div className="border-t border-border/40 px-3 py-3">
          {!hideDiagnosticsUI && (
            <>
              {hasWidgetDebug && activeDebugTab === "data" && renderToolData()}
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
                    Tip: Widget state persists across follow-up turns. Keep
                    under 4k tokens.
                  </div>
                </div>
              )}
              {hasWidgetDebug && activeDebugTab === "sandbox" && (
                <CspWorkbench
                  sandboxInfo={
                    widgetDebugInfo.csp
                      ? {
                          ...widgetDebugInfo.csp,
                          applied: widgetDebugInfo.applied,
                          lifecycle: widgetDebugInfo.lifecycle,
                          mounts: widgetDebugInfo.mounts,
                          hostInfo: widgetDebugInfo.hostInfo ?? null,
                        }
                      : undefined
                  }
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
                          widgetDebugInfo.modelContext.updatedAt
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
                              value={
                                widgetDebugInfo.modelContext.structuredContent
                              }
                              className="p-2 text-[11px]"
                              collapsible
                              defaultExpandDepth={2}
                            />
                          </div>
                        </div>
                      )}

                      <div className="text-[9px] text-muted-foreground/50 mt-2">
                        This context will be included in future turns with the
                        model. Each update overwrites the previous context from
                        this widget.
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground/70 text-[11px]">
                      No model context set by this widget.
                    </div>
                  )}
                </div>
              )}
              {!hasWidgetDebug && renderToolData()}
            </>
          )}
        </div>
      )}
    </div>
  );
}
