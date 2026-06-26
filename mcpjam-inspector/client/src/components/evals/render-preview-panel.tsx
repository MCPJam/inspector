import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Circle, ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { callTool } from "@/lib/apis/mcp-tools-api";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { readToolResultMeta } from "@/lib/tool-result-utils";
import { WidgetReplay } from "@/components/chat-v2/thread/widget-replay";
import { PROBE_TOOL_NAME_PLACEHOLDER } from "@/shared/probe-config";
import type { PinnedToolCall } from "@/shared/steps";
import type { ScriptedStep } from "@/shared/scripted-steps";

/**
 * Live "Render preview" for a render-check turn. Executes the pinned tool call
 * CLIENT-SIDE (one real tool call — may mutate external state) and mounts the
 * resulting MCP App widget via {@link WidgetReplay} so the author can see what
 * they're scripting against.
 *
 * This is a different render instance from the headless harness that runs the
 * eval; only SEMANTIC locators (role/text/testId) transfer between them, which
 * is why the scripted-step authoring uses locator bundles, not coordinates.
 *
 * Tier 2 — when `onRecordStep` is provided, a Record toggle injects a recorder
 * shim into the sandboxed guest (via `recordMode`); clicks/typing in the live
 * widget are captured as steps and appended to the tool's group. Strict-CSP
 * widgets that block the shim surface an explicit "recorder unavailable" state.
 */
export function RenderPreviewPanel({
  pinned,
  onRecordStep,
}: {
  pinned: PinnedToolCall;
  onRecordStep?: (step: ScriptedStep) => void;
}) {
  const [status, setStatus] = useState<
    "idle" | "loading" | "rendered" | "error"
  >("idle");
  const [result, setResult] = useState<unknown>(null);
  const [toolCallId, setToolCallId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // null = unknown; true = shim installed; false = blocked (strict CSP).
  const [recorderReady, setRecorderReady] = useState<boolean | null>(null);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When recording turns on, expect a `recorder:ready` ping shortly; if it
  // never arrives the guest CSP blocked the inline shim — surface that.
  useEffect(() => {
    if (!recording) {
      setRecorderReady(null);
      if (readyTimer.current) clearTimeout(readyTimer.current);
      return;
    }
    readyTimer.current = setTimeout(() => {
      setRecorderReady((prev) => (prev === null ? false : prev));
    }, 2500);
    return () => {
      if (readyTimer.current) clearTimeout(readyTimer.current);
    };
  }, [recording]);

  // Id wins over name (mirrors the runner's resolvePinnedServerKey).
  const serverRef = pinned.serverId ?? pinned.serverName;
  const toolReady =
    !!pinned.toolName &&
    pinned.toolName.trim().length > 0 &&
    pinned.toolName !== PROBE_TOOL_NAME_PLACEHOLDER;
  const canRender = !!serverRef && toolReady;

  const run = async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await callTool(
        serverRef,
        pinned.toolName,
        (pinned.arguments ?? {}) as Record<string, unknown>,
      );
      setResult(res);
      setToolCallId(`preview-${Date.now()}`);
      setStatus("rendered");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  // After a render, decide whether the tool actually returned a widget so we can
  // show an honest "no widget" note instead of an empty box (WidgetReplay
  // renders null when there's no UI resource).
  const hasWidget =
    status === "rendered" &&
    (() => {
      const uiType = detectUIType(readToolResultMeta(result), result);
      return (
        uiType === UIType.MCP_APPS ||
        uiType === UIType.OPENAI_SDK ||
        uiType === UIType.OPENAI_SDK_AND_MCP_APPS
      );
    })();

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[13px] text-foreground">Render check</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {pinned.toolName || "pinned tool"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Record toggle: only when recording is wired AND a widget is live. */}
          {onRecordStep && status === "rendered" && hasWidget ? (
            <Button
              type="button"
              variant={recording ? "secondary" : "outline"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              aria-pressed={recording}
              onClick={() => setRecording((r) => !r)}
            >
              <Circle
                className={
                  "mr-1 h-2.5 w-2.5" +
                  (recording ? " fill-red-500 text-red-500" : "")
                }
              />
              {recording ? "Recording" : "Record"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={run}
            disabled={!canRender || status === "loading"}
          >
            {status === "loading" ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            {status === "rendered" ? "Re-render" : "Render preview"}
          </Button>
        </div>
      </div>
      {/* Side-effect warning stays visible whenever the (Re-)render button is —
          not only in the empty state — since it runs the real tool each time. */}
      {canRender ? (
        <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Runs the real {pinned.toolName || "tool"} call — may mutate state.
        </div>
      ) : null}
      <div className="border-t border-border bg-muted/20 p-3">
        {status === "rendered" ? (
          hasWidget ? (
            <>
              {recording && recorderReady === false ? (
                <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    Recorder unavailable — this widget&apos;s CSP blocked the
                    capture script. Add steps with manual locators instead.
                  </span>
                </div>
              ) : null}
              <WidgetReplay
                toolName={pinned.toolName}
                toolCallId={toolCallId}
                toolState="output-available"
                toolInput={(pinned.arguments ?? {}) as Record<string, unknown>}
                toolOutput={result}
                rawOutput={result}
                minimalMode
                recordMode={recording}
                onRecorderReady={() => setRecorderReady(true)}
                onRecorderStep={(step) => onRecordStep?.(step as ScriptedStep)}
              />
            </>
          ) : (
            <div className="grid h-24 w-full place-items-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
              Tool ran but returned no widget UI.
            </div>
          )
        ) : status === "error" ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[11px] text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : (
          <div className="grid h-24 w-full place-items-center rounded-lg border border-dashed border-border px-3 text-center text-[11px] text-muted-foreground">
            {canRender
              ? "Click Render preview to mount the widget and script against it."
              : "Pick a server and tool above to preview the widget."}
          </div>
        )}
      </div>
    </div>
  );
}
