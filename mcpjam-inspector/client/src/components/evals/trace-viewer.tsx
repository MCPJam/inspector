import {
  lazy,
  Suspense,
  useMemo,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { Loader2, Minus, Plus, Code2, Columns2 } from "lucide-react";
import { StickToBottom } from "use-stick-to-bottom";
import { Button } from "@mcpjam/design-system/button";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { JsonEditor } from "@/components/ui/json-editor";
import { Thread } from "@/components/chat-v2/thread";
import type { DisplayMode } from "@/stores/ui-playground-store";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
  type TraceMessage,
} from "./trace-viewer-adapter";
import {
  buildPromptGroups,
  collectStepSpanIdsWithChildren,
  type TraceRevealSelection,
} from "./trace-timeline";
import {
  RecordedTraceToolbar,
  type TimelineFilter,
} from "./recorded-trace-toolbar";
import { cn } from "@/lib/utils";
import { TraceViewModeTabs } from "./trace-view-mode-tabs";
import { ToolCallsDiffView } from "./tool-calls-diff-view";
import {
  TraceRawView,
  type TraceRawRequestPayloadHistory,
} from "./trace-raw-view";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

// Default host-style template id used when the caller passes
// `activeHost` but no explicit `hostStyle`. Mirrors
// `DEFAULT_HOST_TEMPLATE_ID` in `lib/client-templates.ts` but inlined to
// avoid pulling that module (and its build-time `__APP_VERSION__`
// reference) into surfaces that don't otherwise need it — keeps
// trace-viewer test environments lean.
const DEFAULT_TRACE_HOST_STYLE_FALLBACK = "mcpjam";

const TraceTimelineLazy = lazy(() =>
  import("./trace-timeline").then((m) => ({ default: m.TraceTimeline })),
);

const NOOP = (..._args: unknown[]) => {};

export type TraceViewerEvalToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

interface TraceViewerProps {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  model?: ModelDefinition;
  /**
   * Chat: forwarded to the transcript `Thread`. Tools (Results): shows a spinner
   * beside "Actual" while the run is still in progress.
   */
  isLoading?: boolean;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
  connectedServerIds?: string[];
  /** Wall-clock timestamp for the trace start when available. */
  traceStartedAtMs?: number | null;
  /** Wall-clock timestamp for the trace end when available. */
  traceEndedAtMs?: number | null;
  /** Fallback when the blob has no recorded spans (Convex wall-clock only). */
  estimatedDurationMs?: number | null;
  /** Shown under the toolbar row (e.g. run case insight caption). */
  traceInsight?: ReactNode;
  /** Tighter toolbar/card spacing for full-pane run detail. */
  chromeDensity?: "default" | "compact";
  /** Expected tool calls from the eval case (snapshot); enables the Tools tab. */
  expectedToolCalls?: TraceViewerEvalToolCall[];
  /** Tool calls observed for this iteration; enables the Tools tab. */
  actualToolCalls?: TraceViewerEvalToolCall[];
  /** Force a single mode (used when TraceViewer is embedded into a larger shell). */
  forcedViewMode?: "timeline" | "chat" | "raw" | "tools";
  /** Hide the internal toolbar when the parent shell provides its own tabs. */
  hideToolbar?: boolean;
  /** Let the active panel fill the available height instead of clamping to a max height. */
  fillContent?: boolean;
  /** Hide transcript reveal controls when the parent shell owns chat mode separately. */
  hideTranscriptRevealControls?: boolean;
  /**
   * When `forcedViewMode` is set (e.g. parent tabs), internal `setViewMode("chat")` from
   * "Reveal in Chat" is ignored — call this so the shell can switch to its chat tab.
   */
  onRevealNavigateToChat?: () => void;
  chatSessionId?: string;
  sendFollowUpMessage?: (text: string) => void;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  interactive?: boolean;
  enableFullscreenChatOverlay?: boolean;
  fullscreenChatPlaceholder?: string;
  fullscreenChatDisabled?: boolean;
  fullscreenChatSendBlocked?: boolean;
  onFullscreenChatStop?: () => void;
  /** Forwarded to `Thread` so ancestors can drop GPU transforms that trap `position: fixed` widgets. */
  onFullscreenChange?: (isFullscreen: boolean) => void;
  /**
   * When set (live chat), Raw tab shows the resolved model request payload
   * (`system`, `tools`, `messages`) instead of the diagnostic trace blob.
   */
  rawRequestPayloadHistory?: TraceRawRequestPayloadHistory | null;
  /**
   * When true, Raw JSON uses `height: auto` and minimal wrappers so a parent
   * `StickToBottom` (or similar) owns vertical scroll as the payload grows.
   */
  rawGrowWithContent?: boolean;
  /**
   * Active host (resolved by `useAppState`) at the time the trace is
   * being viewed — NOT the host that was active when the trace was
   * recorded. When provided, TraceViewer installs an inner
   * `ActiveHostCapsResolverScope` so the render gate matches what the
   * user is modeling right now (switch to Codex → widgets hide in
   * replays). When `undefined`, TraceViewer does NOT install an inner
   * scope — any outer scope from a parent chat surface (e.g.
   * `ClientStyledChatTabV2`, `PlaygroundTab`) flows through with the
   * user's saved capability edits intact. Pass `null` explicitly to
   * install a scope with no host (template-seed fallback).
   */
  activeHost?: HostConfigDtoV2 | null;
  /**
   * Host style fallback used when an inner scope is installed but no
   * `activeHost` is provided. Like `activeHost`, passing `undefined`
   * (the default) means "don't install an inner scope" — DO NOT read
   * the surrounding `ChatboxHostStyleProvider` here, because that
   * ambient style would synthesize template-seed caps that shadow
   * outer scope's user-edited caps.
   */
  hostStyle?: string;
}

function getTraceMessages(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
) {
  if (!trace) return [];

  if (Array.isArray(trace)) {
    return trace;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "messages" in trace &&
    Array.isArray(trace.messages)
  ) {
    return trace.messages;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "role" in trace &&
    typeof trace.role === "string"
  ) {
    return [trace as TraceMessage];
  }

  return [];
}

function getRecordedSpans(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
): EvalTraceSpan[] | undefined {
  if (!trace || Array.isArray(trace)) return undefined;
  if (typeof trace !== "object") return undefined;
  if (!("spans" in trace)) return undefined;
  const raw = (trace as TraceEnvelope).spans;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as EvalTraceSpan[];
}

export function TraceViewer({
  trace,
  model,
  isLoading = false,
  toolsMetadata = {},
  toolServerMap = {},
  connectedServerIds = [],
  traceStartedAtMs = null,
  traceEndedAtMs = null,
  estimatedDurationMs = null,
  traceInsight,
  chromeDensity = "default",
  expectedToolCalls = [],
  actualToolCalls = [],
  forcedViewMode,
  hideToolbar = false,
  fillContent = false,
  hideTranscriptRevealControls = false,
  onRevealNavigateToChat,
  chatSessionId,
  sendFollowUpMessage = NOOP,
  onWidgetStateChange,
  onModelContextUpdate,
  displayMode,
  onDisplayModeChange,
  onToolApprovalResponse,
  interactive = false,
  enableFullscreenChatOverlay = false,
  fullscreenChatPlaceholder = "Message…",
  fullscreenChatDisabled = false,
  fullscreenChatSendBlocked,
  onFullscreenChatStop,
  onFullscreenChange,
  rawRequestPayloadHistory = null,
  rawGrowWithContent = false,
  activeHost,
  hostStyle,
}: TraceViewerProps) {
  // Only live chat shells should opt into the interactive widget path.
  const threadInteractive = interactive || sendFollowUpMessage !== NOOP;

  // Decide whether to install an inner ActiveHostCapsResolverScope around
  // the trace's `<Thread>`. We only install when the caller passed
  // explicit `activeHost` or `hostStyle` props. When neither is given,
  // we pass through to any outer scope (e.g. the chat surface's
  // ClientStyledChatTabV2 / PlaygroundTab wrap) — installing a scope
  // here unconditionally would shadow that outer scope with
  // template-seed caps and silently drop the user's saved
  // `clientCapabilities` edits. See TL feedback on PR #2169.
  //
  // `hostStyle` falls back to `DEFAULT_TRACE_HOST_STYLE_FALLBACK` only
  // when the inner scope IS being installed (caller passed activeHost
  // but no explicit hostStyle); we don't reach into the ambient
  // ChatboxHostStyleProvider here, because that ambient style may not
  // line up with the explicit `activeHost`.
  const shouldInstallTraceScope =
    activeHost !== undefined || hostStyle !== undefined;
  const traceScopeHostStyle =
    hostStyle ?? DEFAULT_TRACE_HOST_STYLE_FALLBACK;

  const [viewMode, setViewMode] = useState<
    "timeline" | "chat" | "raw" | "tools"
  >("timeline");
  const [toolsCompareLayout, setToolsCompareLayout] = useState<"diff" | "json">(
    "diff",
  );
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [transcriptNavigation, setTranscriptNavigation] = useState<{
    focusMessageId: string | null;
    highlightedMessageIds: string[];
    navigationKey: number;
  }>({
    focusMessageId: null,
    highlightedMessageIds: [],
    navigationKey: 0,
  });
  const [timelineViewportMaxMs, setTimelineViewportMaxMs] = useState(1);
  const resolvedModel: ModelDefinition = model ?? {
    id: "unknown",
    name: "Unknown",
    provider: "custom" as ModelProvider,
  };
  const traceMessages = getTraceMessages(trace);
  const hasEvalToolCalls =
    expectedToolCalls.length > 0 || actualToolCalls.length > 0;
  const effectiveViewMode = forcedViewMode ?? viewMode;
  const recordedSpans = useMemo(() => getRecordedSpans(trace), [trace]);
  const promptGroups = useMemo(
    () => (recordedSpans?.length ? buildPromptGroups(recordedSpans) : []),
    [recordedSpans],
  );
  const traceIdentityForToolbar = useMemo(
    () =>
      recordedSpans
        ?.map((span) => `${span.id}:${span.startMs}:${span.endMs}`)
        .join("|") ?? "no-spans",
    [recordedSpans],
  );
  const maxEndMsForToolbar = useMemo(
    () =>
      recordedSpans?.length
        ? recordedSpans.reduce((max, span) => Math.max(max, span.endMs), 1)
        : 1,
    [recordedSpans],
  );
  const fullyExpandedStepIds = useMemo(
    () => collectStepSpanIdsWithChildren(promptGroups),
    [promptGroups],
  );
  const isTimelineFullyExpanded = useMemo(() => {
    if (promptGroups.length === 0) return false;
    for (const group of promptGroups) {
      if (!expandedPromptIds.has(group.key)) return false;
    }
    for (const id of fullyExpandedStepIds) {
      if (!expandedStepIds.has(id)) return false;
    }
    return true;
  }, [promptGroups, expandedPromptIds, expandedStepIds, fullyExpandedStepIds]);

  useEffect(() => {
    setTimelineViewportMaxMs(maxEndMsForToolbar);
  }, [maxEndMsForToolbar, traceIdentityForToolbar]);

  useEffect(() => {
    setTimelineFilter("all");
    if (!recordedSpans?.length) {
      setExpandedPromptIds(new Set());
      setExpandedStepIds(new Set());
      return;
    }
    setExpandedPromptIds(new Set(promptGroups.map((g) => g.key)));
    setExpandedStepIds(collectStepSpanIdsWithChildren(promptGroups));
  }, [traceIdentityForToolbar, promptGroups, recordedSpans?.length]);

  const adaptedTrace = useMemo(
    () =>
      adaptTraceToUiMessages({
        trace,
        toolsMetadata,
        toolServerMap,
        connectedServerIds,
      }),
    [trace, toolsMetadata, toolServerMap, connectedServerIds],
  );

  useEffect(() => {
    setTranscriptNavigation({
      focusMessageId: null,
      highlightedMessageIds: [],
      navigationKey: 0,
    });
  }, [trace]);

  useEffect(() => {
    if (!hasEvalToolCalls) {
      setViewMode((mode) => (mode === "tools" ? "timeline" : mode));
    }
  }, [hasEvalToolCalls]);

  useEffect(() => {
    if (effectiveViewMode !== "raw" && effectiveViewMode !== "chat") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setViewMode("timeline");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [effectiveViewMode]);

  function handleRevealInTranscript(selection: TraceRevealSelection) {
    const highlightedIds = new Set<string>();
    for (const sourceIndex of selection.highlightSourceIndices) {
      for (const messageId of adaptedTrace.sourceMessageIndexToUiMessageIds[
        sourceIndex
      ] ?? []) {
        highlightedIds.add(messageId);
      }
    }

    const focusMessageId =
      adaptedTrace.sourceMessageIndexToFocusUiMessageId[
        selection.focusSourceIndex
      ] ??
      adaptedTrace.sourceMessageIndexToUiMessageIds[
        selection.focusSourceIndex
      ]?.[0] ??
      null;
    if (focusMessageId) {
      highlightedIds.add(focusMessageId);
    }

    const orderedIds = adaptedTrace.messages
      .map((message) => message.id)
      .filter((messageId) => highlightedIds.has(messageId));
    if (orderedIds.length === 0 || !focusMessageId) {
      return;
    }

    setTranscriptNavigation((current) => ({
      focusMessageId,
      highlightedMessageIds: orderedIds,
      navigationKey: current.navigationKey + 1,
    }));
    if (forcedViewMode != null) {
      if (forcedViewMode !== "chat") {
        onRevealNavigateToChat?.();
      }
    } else {
      setViewMode("chat");
    }
  }

  if (!trace) {
    return (
      <div className="text-xs text-muted-foreground">
        No trace data available
      </div>
    );
  }

  const hasRecordedSpans = Boolean(recordedSpans?.length);
  const showRecordedChrome =
    effectiveViewMode === "timeline" && hasRecordedSpans;
  const timelineZoomMinMs = Math.max(1, Math.round(maxEndMsForToolbar / 50));
  const compactChrome = chromeDensity === "compact";
  const flexFillChrome =
    fillContent ||
    effectiveViewMode === "raw" ||
    (effectiveViewMode === "tools" && hasEvalToolCalls);

  const toolsCompareLayoutToggle = (
    <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background p-0.5">
      <button
        type="button"
        onClick={() => setToolsCompareLayout("diff")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
          toolsCompareLayout === "diff"
            ? "bg-primary/10 font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Structured diff view"
        data-testid="trace-viewer-tools-layout-diff"
      >
        <Columns2 className="size-3" aria-hidden />
        Diff
      </button>
      <button
        type="button"
        onClick={() => setToolsCompareLayout("json")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
          toolsCompareLayout === "json"
            ? "bg-primary/10 font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Raw JSON view"
        data-testid="trace-viewer-tools-layout-json"
      >
        <Code2 className="size-3" aria-hidden />
        JSON
      </button>
    </div>
  );

  return (
    <div
      className={cn(flexFillChrome && "flex min-h-0 min-w-0 flex-1 flex-col")}
      data-testid="trace-viewer-root"
    >
      <div
        className={cn(
          compactChrome ? "space-y-2" : "space-y-3",
          flexFillChrome && "flex min-h-0 min-w-0 flex-1 flex-col",
        )}
      >
        {!hideToolbar ? (
          <div
            className={cn(
              "sticky top-0 z-20 rounded-lg border border-border/50 bg-muted/95 shadow-sm backdrop-blur-sm",
              flexFillChrome && "shrink-0",
              compactChrome ? "px-2 py-1.5 sm:px-2.5" : "px-2 py-2 sm:px-3",
            )}
          >
            <div
              className={cn(
                "flex min-w-0 flex-row items-center justify-between gap-2",
                compactChrome ? "min-h-8" : "min-h-9",
              )}
            >
              <div className="flex min-w-0 min-h-0 flex-1 items-center gap-2">
                {showRecordedChrome ? (
                  <RecordedTraceToolbar
                    filter={timelineFilter}
                    onFilterChange={setTimelineFilter}
                    isFullyExpanded={isTimelineFullyExpanded}
                    expandDisabled={promptGroups.length === 0}
                    showBottomBorder={false}
                    zoomControls={
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-7 w-7 border-border/50"
                          title="Zoom in timeline"
                          aria-label="Zoom in timeline"
                          disabled={timelineViewportMaxMs <= timelineZoomMinMs}
                          onClick={() =>
                            setTimelineViewportMaxMs((v) =>
                              Math.max(timelineZoomMinMs, Math.round(v * 0.8)),
                            )
                          }
                        >
                          <Plus className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-7 w-7 border-border/50"
                          title="Zoom out timeline"
                          aria-label="Zoom out timeline"
                          disabled={
                            timelineViewportMaxMs >= maxEndMsForToolbar * 4
                          }
                          onClick={() =>
                            setTimelineViewportMaxMs((v) =>
                              Math.min(
                                maxEndMsForToolbar * 4,
                                Math.round(v * 1.25),
                              ),
                            )
                          }
                        >
                          <Minus className="size-3.5" aria-hidden />
                        </Button>
                      </>
                    }
                    onToggleExpandAll={() => {
                      if (isTimelineFullyExpanded) {
                        setExpandedPromptIds(new Set());
                        setExpandedStepIds(new Set());
                      } else {
                        setExpandedPromptIds(
                          new Set(promptGroups.map((group) => group.key)),
                        );
                        setExpandedStepIds(new Set(fullyExpandedStepIds));
                      }
                    }}
                  />
                ) : (
                  <div className="text-xs font-medium text-muted-foreground">
                    {effectiveViewMode === "raw"
                      ? "Trace JSON"
                      : effectiveViewMode === "tools"
                        ? "Expected vs actual tools"
                        : traceMessages.length > 0
                          ? `${traceMessages.length} message${traceMessages.length !== 1 ? "s" : ""}`
                          : "Trace"}
                  </div>
                )}
              </div>
              {!forcedViewMode ? (
                <TraceViewModeTabs
                  mode={effectiveViewMode}
                  onModeChange={setViewMode}
                  showToolsTab={hasEvalToolCalls}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {traceInsight ? (
          <div
            className={cn(
              "rounded-lg border border-border/50 bg-muted/15",
              flexFillChrome && "shrink-0",
              compactChrome ? "px-2 py-1.5 sm:px-2.5" : "px-2 py-2 sm:px-3",
            )}
            data-testid="trace-viewer-insight-slot"
          >
            {traceInsight}
          </div>
        ) : null}

        {effectiveViewMode === "raw" && (
          <div
            className={cn(
              "min-w-0 flex flex-col",
              rawGrowWithContent
                ? ""
                : cn(
                    "overflow-hidden",
                    flexFillChrome
                      ? "min-h-0 flex-1"
                      : "min-h-0 max-h-[min(70vh,36rem)]",
                  ),
            )}
            data-testid="trace-viewer-raw-json"
          >
            <TraceRawView
              trace={trace}
              requestPayloadHistory={rawRequestPayloadHistory}
              growWithContent={rawGrowWithContent}
            />
          </div>
        )}

        {effectiveViewMode === "timeline" && (
          <Suspense
            fallback={
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <div
              className={cn(
                flexFillChrome &&
                  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              )}
            >
              <TraceTimelineLazy
                recordedSpans={recordedSpans}
                estimatedDurationMs={
                  recordedSpans?.length ? undefined : estimatedDurationMs
                }
                transcriptMessageCount={
                  recordedSpans?.length ? 0 : traceMessages.length
                }
                transcriptMessages={traceMessages}
                traceStartedAtMs={traceStartedAtMs}
                traceEndedAtMs={traceEndedAtMs}
                onRevealInTranscript={
                  hideTranscriptRevealControls
                    ? undefined
                    : handleRevealInTranscript
                }
                hideToolbar={hasRecordedSpans}
                timelineFilter={hasRecordedSpans ? timelineFilter : undefined}
                onTimelineFilterChange={
                  hasRecordedSpans ? setTimelineFilter : undefined
                }
                expandedPromptIds={
                  hasRecordedSpans ? expandedPromptIds : undefined
                }
                onExpandedPromptIdsChange={
                  hasRecordedSpans ? setExpandedPromptIds : undefined
                }
                expandedStepIds={hasRecordedSpans ? expandedStepIds : undefined}
                onExpandedStepIdsChange={
                  hasRecordedSpans ? setExpandedStepIds : undefined
                }
                viewportMaxMs={
                  hasRecordedSpans ? timelineViewportMaxMs : undefined
                }
                fillContent={fillContent}
              />
            </div>
          </Suspense>
        )}

        {effectiveViewMode === "chat" &&
          (traceMessages.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No messages in trace
            </div>
          ) : (
            <div
              className={cn(
                "min-w-0 rounded-md border border-border/30 bg-background/50 flex flex-col",
                fillContent
                  ? "min-h-0 flex-1 overflow-hidden"
                  : "min-h-0",
              )}
              data-testid="trace-viewer-chat"
            >
              {(() => {
                // Trace `<Thread>` mount. Wrapped in
                // `ActiveHostCapsResolverScope` ONLY when the caller
                // passed explicit host inputs (`activeHost` or
                // `hostStyle`). Otherwise we render Thread directly so
                // any outer scope from the chat surface
                // (ClientStyledChatTabV2 / PlaygroundTab) flows through
                // with the user's saved capability edits intact.
                // Installing an inner scope unconditionally would
                // shadow the outer one with template-seed caps.
                const threadEl = (
                  <Thread
                    chatSessionId={chatSessionId}
                    messages={adaptedTrace.messages}
                    sendFollowUpMessage={sendFollowUpMessage}
                    model={resolvedModel}
                    isLoading={isLoading}
                    toolsMetadata={toolsMetadata}
                    toolServerMap={toolServerMap}
                    onWidgetStateChange={onWidgetStateChange}
                    onModelContextUpdate={onModelContextUpdate}
                    displayMode={displayMode}
                    onDisplayModeChange={onDisplayModeChange}
                    enableFullscreenChatOverlay={enableFullscreenChatOverlay}
                    fullscreenChatPlaceholder={fullscreenChatPlaceholder}
                    fullscreenChatDisabled={fullscreenChatDisabled}
                    fullscreenChatSendBlocked={fullscreenChatSendBlocked}
                    onFullscreenChatStop={onFullscreenChatStop}
                    onFullscreenChange={onFullscreenChange}
                    onToolApprovalResponse={onToolApprovalResponse}
                    toolRenderOverrides={adaptedTrace.toolRenderOverrides}
                    showSaveViewButton={false}
                    minimalMode={true}
                    interactive={threadInteractive}
                    reasoningDisplayMode="collapsed"
                    focusMessageId={transcriptNavigation.focusMessageId}
                    highlightedMessageIds={
                      transcriptNavigation.highlightedMessageIds
                    }
                    navigationKey={transcriptNavigation.navigationKey}
                    contentClassName="min-w-0 mx-auto w-full max-w-4xl space-y-8 px-4 pt-2"
                    getMessageWrapperProps={({ message }) => {
                      const sourceRange =
                        adaptedTrace.uiMessageSourceRanges[message.id];
                      return {
                        "data-source-range": sourceRange
                          ? `${sourceRange.startIndex}-${sourceRange.endIndex}`
                          : undefined,
                      };
                    }}
                  />
                );
                const scoped = shouldInstallTraceScope ? (
                  <ActiveHostCapsResolverScope
                    activeHost={activeHost ?? null}
                    hostStyle={traceScopeHostStyle}
                  >
                    {threadEl}
                  </ActiveHostCapsResolverScope>
                ) : (
                  threadEl
                );
                // Live streaming (fillContent): keep StickToBottom so
                // new messages auto-pin to the bottom inside the
                // viewport-bounded shell. Static replay: render
                // directly and let the surrounding page own scroll,
                // starting from the first message.
                if (!fillContent) return scoped;
                return (
                  <StickToBottom
                    className="relative flex min-h-0 flex-1 flex-col"
                    resize="smooth"
                    initial="smooth"
                  >
                    <div className="relative flex-1 min-h-0">
                      <StickToBottom.Content className="flex flex-col min-h-0">
                        {scoped}
                      </StickToBottom.Content>
                      <ScrollToBottomButton />
                    </div>
                  </StickToBottom>
                );
              })()}
            </div>
          ))}

        {effectiveViewMode === "tools" && hasEvalToolCalls ? (
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
            data-testid="trace-viewer-tools-compare"
          >
            {toolsCompareLayout === "diff" ? (
              <ToolCallsDiffView
                expected={expectedToolCalls}
                actual={actualToolCalls}
                isLoading={isLoading}
                headerTrailing={toolsCompareLayoutToggle}
              />
            ) : (
              <>
                <div className="flex shrink-0 items-center justify-end">
                  {toolsCompareLayoutToggle}
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:flex-row">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-md border border-border/40 bg-muted/10 p-3">
                  <div className="shrink-0 text-xs font-medium uppercase text-muted-foreground">
                    Expected
                  </div>
                  {expectedToolCalls.length === 0 ? (
                    <div className="text-xs italic text-muted-foreground">
                      No expected tool calls
                    </div>
                  ) : (
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/30 bg-background/50">
                      <JsonEditor
                        value={expectedToolCalls}
                        viewOnly
                        collapsible
                        defaultExpandDepth={2}
                        collapseStringsAfterLength={160}
                        height="100%"
                        className="min-h-0"
                      />
                    </div>
                  )}
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-md border border-border/40 bg-muted/10 p-3">
                  <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                    Actual
                    {isLoading ? (
                      <Loader2
                        className="h-3 w-3 shrink-0 animate-spin"
                        aria-hidden
                        data-testid="trace-viewer-actual-loading"
                      />
                    ) : null}
                  </div>
                  {actualToolCalls.length === 0 ? (
                    <div className="text-xs italic text-muted-foreground">
                      No tool calls made
                    </div>
                  ) : (
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/30 bg-background/50">
                      <JsonEditor
                        value={actualToolCalls.map(
                          ({ toolName, arguments: args }) => ({
                            toolName,
                            arguments: args,
                          }),
                        )}
                        viewOnly
                        collapsible
                        defaultExpandDepth={2}
                        collapseStringsAfterLength={160}
                        height="100%"
                        className="min-h-0"
                      />
                    </div>
                  )}
                </div>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
