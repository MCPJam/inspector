import { useState, useCallback, useEffect, useRef } from "react";
import { type ToolUIPart, type DynamicToolUIPart, type UITools } from "ai";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/client";

import { ToolPart } from "./parts/tool-part";
import {
  ReasoningPart,
  type ReasoningDisplayMode,
} from "./parts/reasoning-part";
import { FilePart } from "./parts/file-part";
import { SourceUrlPart } from "./parts/source-url-part";
import { SourceDocumentPart } from "./parts/source-document-part";
import { JsonPart } from "./parts/json-part";
import { TextPart } from "./parts/text-part";
import { toast } from "@/lib/toast";
import { type DisplayMode } from "@/stores/ui-playground-store";
import {
  callTool,
  executeToolApi,
  getToolServerId,
  ToolServerMap,
} from "@/lib/apis/mcp-tools-api";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  AnyPart,
  getDataLabel,
  getToolInfo,
  isDataPart,
  isDynamicTool,
  isToolPart,
} from "./thread-helpers";
import { useSharedAppState } from "@/state/app-state-context";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { useChatboxHostStyle } from "@/contexts/chatbox-client-style-context";
import { hostSupportsWidgetRendering } from "@/lib/host-capabilities";
import {
  ToolRenderOverride,
  widgetSlotShouldRender,
} from "@/components/chat-v2/thread/tool-render-overrides";
import { WidgetReplay } from "./widget-replay";
import {
  computeWidgetRecordMode,
  type RecorderReadyEvent,
  type RecorderStepEvent,
  type RecordingTarget,
  type ReplayControllerEvent,
} from "./recorder-types";

import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import type { AppToolInvocationUpdate } from "./app-tool-invocations";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recorderDebug(message: string, details?: Record<string, unknown>) {
  try {
    if (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("mcpjam:recorder-debug") === "1"
    ) {
      console.info(`[recorder] ${message}`, details ?? {});
    }
  } catch {
    // best-effort debug logging only
  }
}

/**
 * Frozen recorded render shown in place of a live widget when a completed eval
 * run is being replayed (see {@link ToolRenderOverride.frozenScreenshotUrl}).
 * Faithful to what the run actually painted; no live re-mount that could drift.
 */
function FrozenWidgetScreenshot({
  url,
  toolName,
}: {
  url: string;
  toolName: string;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="frozen-widget-replay">
      <img
        src={url}
        alt={`${toolName} recorded render`}
        className="w-full rounded-md border border-border/60 bg-background"
      />
      <span className="text-[11px] text-muted-foreground">
        Recorded render — this run's captured widget (not re-rendered live)
      </span>
    </div>
  );
}

export function PartSwitch({
  part,
  role,
  chatSessionId,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  onAppToolInvocationChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestTeardown,
  tornDownWidgetIds,
  displayMode,
  onDisplayModeChange,
  onToolApprovalResponse,
  messageParts,
  toolRenderOverrides,
  showInlineEdit = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  recordCapable,
  recordingTarget,
  resolvePromptIndex,
  onRecorderStep,
  onRecorderReady,
  onReplayControllerReady,
}: {
  part: AnyPart;
  role: UIMessage["role"];
  chatSessionId?: string;
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    }
  ) => void;
  onAppToolInvocationChange?: (invocation: AppToolInvocationUpdate) => void;
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  onRequestTeardown?: (toolCallId: string, displayWidgetId?: string) => void;
  tornDownWidgetIds?: ReadonlySet<string>;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  messageParts?: AnyPart[];
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showInlineEdit?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  // Tier 3 recorder (default off — see recorder-types.ts).
  recordCapable?: boolean;
  recordingTarget?: RecordingTarget | null;
  resolvePromptIndex?: (toolCallId: string) => number | undefined;
  onRecorderStep?: (event: RecorderStepEvent) => void;
  onRecorderReady?: (event: RecorderReadyEvent) => void;
  onReplayControllerReady?: (event: ReplayControllerEvent) => void;
}) {
  const [appSupportedDisplayModes, setAppSupportedDisplayModes] = useState<
    DisplayMode[] | undefined
  >();
  void messageParts;

  const appState = useSharedAppState();
  const resolveHostCaps = useActiveHostCapsResolver();
  const hostStyle = useChatboxHostStyle();

  const toolInfoFromPart =
    isToolPart(part) || isDynamicTool(part)
      ? getToolInfo(part as ToolUIPart<UITools> | DynamicToolUIPart)
      : null;

  // Tool-call identity for the current part (drives the edit reset effect).
  const toolCallId =
    isToolPart(part) || isDynamicTool(part)
      ? ((part as any).toolCallId as string | undefined)
      : undefined;

  // --- Inline live-edit of tool input/output (no persistence) ---
  // Override state lives here so it feeds BOTH the ToolPart data editors and the
  // sibling <WidgetReplay>; the existing sendToolInput/sendToolResult path then
  // re-renders the live iframe with no reload. Sentinel-wrapped so "edited to
  // null" stays distinct from pristine (null = pristine).
  const [isEditing, setIsEditing] = useState(false);
  const [editedInput, setEditedInput] = useState<{ value: unknown } | null>(
    null
  );
  const [editedOutput, setEditedOutput] = useState<{ value: unknown } | null>(
    null
  );
  const [isRunning, setIsRunning] = useState(false);
  // Bumped to remount + reseed the JsonEditors on a hard reset (Revert /
  // Run-result swap / new tool call). Keystroke edits never bump it.
  const [editVersion, setEditVersion] = useState(0);
  // Monotonic token invalidating in-flight Runs. Bumped on every Run start and
  // on any reset (Revert / new tool call / display-mode switch) so a server
  // response that lands after the context changed can't write stale output.
  const runSeqRef = useRef(0);

  const handleInputChange = useCallback(
    (value: unknown) => setEditedInput({ value }),
    []
  );
  const handleOutputChange = useCallback(
    (value: unknown) => setEditedOutput({ value }),
    []
  );
  const handleToggleEdit = useCallback(() => setIsEditing((p) => !p), []);
  const handleRevert = useCallback(() => {
    // Bumping runSeqRef invalidates any in-flight Run, whose guarded `finally`
    // will then skip setIsRunning(false) — so clear it here too, or the card
    // would stay stuck in the running state with Run disabled.
    runSeqRef.current += 1;
    setEditedInput(null);
    setEditedOutput(null);
    setIsRunning(false);
    setEditVersion((v) => v + 1);
  }, []);

  // Drop edits when the tool-call identity changes or the display mode switches.
  useEffect(() => {
    runSeqRef.current += 1;
    setIsEditing(false);
    setEditedInput(null);
    setEditedOutput(null);
    setIsRunning(false);
    setEditVersion((v) => v + 1);
  }, [toolCallId, displayMode]);

  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const toolInfo = toolInfoFromPart ?? getToolInfo(toolPart);
    const approvalId = toolPart.approval?.id;
    const approvalProps =
      interactive && approvalId
        ? {
            approvalId,
            onApprove: (id: string) =>
              onToolApprovalResponse?.({ id, approved: true }),
            onDeny: (id: string) =>
              onToolApprovalResponse?.({ id, approved: false }),
          }
        : {};
    const renderOverride = toolInfo.toolCallId
      ? toolRenderOverrides?.[toolInfo.toolCallId]
      : undefined;
    const partToolMeta = toolsMetadata[toolInfo.toolName];
    const streamedToolMeta = readToolResultMeta(toolInfo.rawOutput);
    const effectiveToolMeta =
      renderOverride?.toolMetadata ?? partToolMeta ?? streamedToolMeta;
    const uiType = detectUIType(effectiveToolMeta, toolInfo.rawOutput);
    // MCP-UI legacy (inline ui:// resources via @mcp-ui/client) was
    // removed during the renderer consolidation. Inline resources are no
    // longer rendered; tools that want a widget must declare it via
    // `_meta.ui.resourceUri` or `openai/outputTemplate`.
    const serverId =
      renderOverride?.serverId ??
      getToolServerId(toolInfo.toolName, toolServerMap) ??
      readToolResultServerId(toolInfo.rawOutput);
    const hasRenderOverrideToolOutput =
      renderOverride !== undefined &&
      Object.prototype.hasOwnProperty.call(renderOverride, "toolOutput");
    const resolvedToolOutput = hasRenderOverrideToolOutput
      ? renderOverride.toolOutput
      : toolInfo.output ?? toolInfo.rawOutput;

    // --- Inline edit: effective values fed to BOTH the editors and the iframe ---
    const baseInput = (toolInfo.input ?? null) as Record<string, unknown> | null;
    // Tool input is an arguments object. Mirror the output normalization: ignore
    // non-object edits (null / array / string) for BOTH the live widget feed and
    // Run, falling back to the original — otherwise the preview could render one
    // payload while Run executes a coerced `{}`. They must stay identical.
    const effectiveInput: Record<string, unknown> | null = editedInput
      ? isPlainObject(editedInput.value)
        ? editedInput.value
        : baseInput
      : baseInput;
    const baseOutput = resolvedToolOutput;
    const effectiveOutput = (() => {
      if (!editedOutput) return baseOutput;
      const edited = editedOutput.value;
      // Tool results are always objects (CallToolResult). Ignore non-object /
      // null edits for rendering and fall back to the original: the renderer
      // coalesces a null `toolOutput` back to `rawOutput` and the streaming
      // hook skips falsy output, so feeding null would silently diverge the
      // widget from the editor. Object edits flow through with `_meta` pinned
      // to the original (edits can never repoint the binding or leak into
      // toolResponseMetadata; binding also derives from rawOutput, which we
      // never override).
      if (!isPlainObject(edited)) return baseOutput;
      return isPlainObject(baseOutput)
        ? { ...edited, _meta: baseOutput._meta }
        : edited;
    })();
    const hasEdits = editedInput !== null || editedOutput !== null;

    const isServerConnected =
      !!serverId &&
      appState.servers[serverId]?.connectionStatus === "connected";
    // Frozen eval replays render a screenshot (no live iframe) → no inline edit.
    const allowInlineEdit =
      interactive &&
      showInlineEdit &&
      !minimalMode &&
      !renderOverride?.frozenScreenshotUrl &&
      toolInfo.toolState === "output-available";
    const canRun = allowInlineEdit && isServerConnected && !isRunning;

    const handleRun = async () => {
      if (!serverId) return;
      // Token this Run. A reset (new tool call / display-mode switch / Revert)
      // or a newer Run bumps runSeqRef, after which every state write below
      // is skipped — a late response can't clobber the current context.
      const seq = (runSeqRef.current += 1);
      const params = isPlainObject(effectiveInput) ? effectiveInput : {};
      setIsRunning(true);
      try {
        const res = await executeToolApi(serverId, toolInfo.toolName, params);
        if (runSeqRef.current !== seq) return;
        if ("error" in res) {
          toast.error(`Execution failed: ${res.error}`);
          return;
        }
        if (res.status === "elicitation_required") {
          toast.error("Tool requires elicitation (not supported here)");
          return;
        }
        if (res.status === "task_created") {
          toast.error("Background tasks are not supported here");
          return;
        }
        setEditedOutput({ value: res.result });
        setEditVersion((v) => v + 1);
      } catch (err) {
        if (runSeqRef.current === seq) {
          toast.error(err instanceof Error ? err.message : "Execution failed");
        }
      } finally {
        if (runSeqRef.current === seq) setIsRunning(false);
      }
    };

    // Gate widget render on the active host's advertised capabilities for
    // this tool's server. Hosts that don't advertise the MCP UI extension
    // (Codex — elicitation-only client) fall through to the plain
    // ToolPart result row, even when the tool itself declares
    // `_meta.ui.resourceUri` / `openai/outputTemplate`. This mirrors what
    // real CLI clients do: tool runs, JSON result is shown, no iframe.
    //
    // `serverId` (computed above for save-view routing) is passed through
    // so the resolver picks up any per-server `clientCapabilities`
    // override — keeping the renderer in lockstep with `initialize`,
    // which uses the same `resolveEffectiveClientCapabilities` function.
    //
    // Note on Apps SDK hosts (ChatGPT, Copilot): their templates KEEP the
    // SDK-default MCP UI extension in `clientCapabilities`, so they pass
    // this gate today. A future explicit "window.openai" flag on
    // HostConfigInputV2 will be OR-ed here to cover Apps-SDK hosts that
    // choose to strip the MCP UI extension.
    const isWidgetTornDown =
      typeof toolInfo.toolCallId === "string" &&
      tornDownWidgetIds?.has(toolInfo.toolCallId);
    const shouldRenderWidget =
      !isWidgetTornDown &&
      hostSupportsWidgetRendering(resolveHostCaps(serverId ?? undefined), {
        hostStyle,
      }) &&
      (uiType === UIType.OPENAI_SDK ||
        uiType === UIType.MCP_APPS ||
        uiType === UIType.OPENAI_SDK_AND_MCP_APPS);

    // A frozen recorded screenshot (eval replay) renders INDEPENDENTLY of live
    // widget eligibility: a completed run's widget can fail host-caps / server /
    // `uiType` checks at view-time, but we still have its capture. The inner
    // ternary below shows the screenshot in place of the live <WidgetReplay>.
    if (widgetSlotShouldRender(shouldRenderWidget, renderOverride)) {
      return (
        <>
          <ToolPart
            part={toolPart}
            chatSessionId={chatSessionId}
            uiType={uiType}
            displayMode={interactive ? displayMode : undefined}
            pipWidgetId={pipWidgetId}
            fullscreenWidgetId={fullscreenWidgetId}
            onDisplayModeChange={interactive ? onDisplayModeChange : undefined}
            onRequestFullscreen={interactive ? onRequestFullscreen : undefined}
            onExitFullscreen={interactive ? onExitFullscreen : undefined}
            onRequestPip={interactive ? onRequestPip : undefined}
            onExitPip={interactive ? onExitPip : undefined}
            appSupportedDisplayModes={
              interactive ? appSupportedDisplayModes : undefined
            }
            allowInlineEdit={allowInlineEdit}
            isEditing={isEditing}
            onToggleEdit={handleToggleEdit}
            onInputChange={handleInputChange}
            onOutputChange={handleOutputChange}
            inputValue={effectiveInput}
            outputValue={effectiveOutput}
            hasEdits={hasEdits}
            onRevert={handleRevert}
            onRun={handleRun}
            isRunning={isRunning}
            canRun={canRun}
            editVersion={editVersion}
            minimalMode={minimalMode}
            {...approvalProps}
          />
          {renderOverride?.frozenScreenshotUrl ? (
            <FrozenWidgetScreenshot
              url={renderOverride.frozenScreenshotUrl}
              toolName={toolInfo.toolName}
            />
          ) : (
            <WidgetReplay
              chatSessionId={chatSessionId}
              toolName={toolInfo.toolName}
              toolCallId={toolInfo.toolCallId}
              {...(() => {
                // Tier 3 recorder. DECOUPLED from arming: on a record-capable
                // surface (the eval preview) EVERY widget loads the shim on first
                // render, so arming never reloads a widget. Reloading on arm would
                // re-run the widget's `ui/initialize` without closing the previous
                // App instance → a second AppBridge → misrouted handshake and no
                // `recorder:ready`. Arming is a host-side SAVE gate (handled in the
                // editor's onRecorderStep), not a reload trigger.
                const tcid = toolInfo.toolCallId;
                const widgetPromptIndex = tcid
                  ? resolvePromptIndex?.(tcid)
                  : undefined;
                const { recordMode, promptIndex: pi } = computeWidgetRecordMode(
                  {
                    recordCapable,
                    recordingTarget,
                    toolName: toolInfo.toolName,
                    toolCallId: tcid,
                    widgetPromptIndex,
                  }
                );
                recorderDebug("part record decision", {
                  toolName: toolInfo.toolName,
                  toolCallId: tcid ?? null,
                  hasToolCallId: !!tcid,
                  recordCapable: !!recordCapable,
                  recordMode,
                  widgetPromptIndex: widgetPromptIndex ?? null,
                  recordingTarget: recordingTarget ?? null,
                });
                if (!recordMode) return {};
                const toolCallId = tcid as string;
                return {
                  recordMode: true,
                  onRecorderStep: (step: unknown) => {
                    recorderDebug("part recorder step", {
                      toolName: toolInfo.toolName,
                      toolCallId,
                      promptIndex: pi,
                    });
                    onRecorderStep?.({
                      promptIndex: pi,
                      toolName: toolInfo.toolName,
                      toolCallId,
                      step,
                    });
                  },
                  onRecorderReady: () => {
                    recorderDebug("part recorder ready", {
                      toolName: toolInfo.toolName,
                      toolCallId,
                      promptIndex: pi,
                    });
                    onRecorderReady?.({
                      promptIndex: pi,
                      toolName: toolInfo.toolName,
                      toolCallId,
                    });
                  },
                  onReplayControllerReady: (
                    replay: ReplayControllerEvent["replay"]
                  ) => {
                    onReplayControllerReady?.({
                      promptIndex: pi,
                      toolName: toolInfo.toolName,
                      toolCallId,
                      replay,
                    });
                  },
                };
              })()}
              toolState={toolInfo.toolState}
              toolInput={effectiveInput}
              toolOutput={effectiveOutput}
              rawOutput={toolInfo.rawOutput}
              toolErrorText={toolInfo.errorText}
              toolMetadata={effectiveToolMeta}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              renderOverride={renderOverride}
              // PartSwitch owns the inspector host-capabilities context; inject
              // the gate so WidgetReplay re-checks per-server support without
              // importing `@/contexts` / `@/lib/host-capabilities` itself.
              resolveHostSupportsWidget={(sid) =>
                hostSupportsWidgetRendering(resolveHostCaps(sid), { hostStyle })
              }
              onSendFollowUp={interactive ? onSendFollowUp : undefined}
              onCallTool={
                interactive
                  ? (toolName, params) =>
                      callTool(serverId ?? "offline-view", toolName, params)
                  : undefined
              }
              onAppToolInvocationChange={onAppToolInvocationChange}
              onWidgetStateChange={
                interactive ? onWidgetStateChange : undefined
              }
              onModelContextUpdate={
                interactive ? onModelContextUpdate : undefined
              }
              pipWidgetId={pipWidgetId}
              fullscreenWidgetId={fullscreenWidgetId}
              onRequestPip={interactive ? onRequestPip : undefined}
              onExitPip={interactive ? onExitPip : undefined}
              onRequestFullscreen={
                interactive ? onRequestFullscreen : undefined
              }
              onExitFullscreen={interactive ? onExitFullscreen : undefined}
              onRequestTeardown={interactive ? onRequestTeardown : undefined}
              displayMode={interactive ? displayMode : undefined}
              onDisplayModeChange={
                interactive ? onDisplayModeChange : undefined
              }
              onAppSupportedDisplayModesChange={
                interactive ? setAppSupportedDisplayModes : undefined
              }
              minimalMode={minimalMode}
            />
          )}
        </>
      );
    }

    return (
      <ToolPart
        part={toolPart}
        chatSessionId={chatSessionId}
        uiType={uiType}
        minimalMode={minimalMode}
        {...approvalProps}
      />
    );
  }

  if (isDataPart(part)) {
    return (
      <JsonPart
        label={getDataLabel(part.type)}
        value={(part as any).data}
        autoHeight={Boolean((part as any).autoHeight)}
      />
    );
  }

  switch (part.type) {
    case "text":
      return <TextPart text={part.text} role={role} />;
    case "reasoning":
      return (
        <ReasoningPart
          text={part.text}
          state={part.state}
          displayMode={reasoningDisplayMode}
        />
      );
    case "file":
      return <FilePart part={part} />;
    case "source-url":
      return <SourceUrlPart part={part} />;
    case "source-document":
      return <SourceDocumentPart part={part} />;
    case "step-start":
      return null;
    default:
      return <JsonPart label="Unknown part" value={part} />;
  }
}
