import { useCallback, useEffect, useMemo, useState } from "react";
import { isHostedMode } from "@/lib/apis/mode-client";
import { getCompatRuntimeForStyle } from "@/lib/client-styles/registry";
import {
  renderWidget,
  type WidgetRenderResult,
  type WidgetRenderStatus,
} from "@/lib/apis/mcp-widget-render-api";
import type {
  HostCompatReport,
  ServerRequirements,
} from "@/lib/host-compat/types";

/** A single host's live-render outcome: a render result, or a request error. */
export type LiveRenderOutcome = {
  result?: WidgetRenderResult;
  error?: string;
};

/**
 * Tier-2 "observed" apps-lane render. Renders one of the server's widget tools
 * in the local headless harness under a given host's `injectOpenAiCompat`, and
 * tracks the observed status per host. Local-Inspector only (the render route
 * is `!HOSTED_MODE`); `available` is false in hosted mode or when the server
 * has no widget to render.
 *
 * v1 renders the server's FIRST widget tool as a representative observation;
 * multi-widget servers report on that one tool.
 */
export function useLiveRenders(
  serverName: string,
  requirements: ServerRequirements,
) {
  const [runningHostId, setRunningHostId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, LiveRenderOutcome>>({});

  // Drop results when the server changes so one server's renders never show
  // under another.
  useEffect(() => {
    setResults({});
    setRunningHostId(null);
  }, [serverName]);

  const widgetTool = useMemo(
    () =>
      [
        ...requirements.widgets.mcpAppsOnly,
        ...requirements.widgets.dual,
        ...requirements.widgets.openaiAppsOnly,
      ][0],
    [requirements.widgets],
  );

  const available = !isHostedMode() && !!widgetTool;

  const run = useCallback(
    async (report: HostCompatReport) => {
      if (!widgetTool) return;
      const injectOpenAiCompat = getCompatRuntimeForStyle(
        report.hostId,
      ).injected;
      setRunningHostId(report.hostId);
      try {
        const result = await renderWidget({
          serverId: serverName,
          toolName: widgetTool,
          injectOpenAiCompat,
        });
        setResults((prev) => ({ ...prev, [report.hostId]: { result } }));
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [report.hostId]: {
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setRunningHostId(null);
      }
    },
    [serverName, widgetTool],
  );

  return { available, runningHostId, results, run, widgetTool };
}

const STATUS_META: Record<
  WidgetRenderStatus,
  { label: string; tone: "ok" | "bad" | "neutral" }
> = {
  rendered: { label: "Rendered", tone: "ok" },
  no_ui_resource: { label: "No widget resource", tone: "neutral" },
  resource_read_failed: { label: "Resource read failed", tone: "bad" },
  mount_failed: { label: "Failed to mount", tone: "bad" },
  bridge_timeout: { label: "Bridge timed out", tone: "bad" },
  render_error: { label: "Render error", tone: "bad" },
  blank_screenshot: { label: "Rendered blank", tone: "bad" },
  screenshot_failed: { label: "Screenshot failed", tone: "neutral" },
  browser_unavailable: { label: "Browser unavailable", tone: "neutral" },
};

const TONE_TEXT: Record<"ok" | "bad" | "neutral", string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};
const TONE_DOT: Record<"ok" | "bad" | "neutral", string> = {
  ok: "bg-emerald-500",
  bad: "bg-red-500",
  neutral: "bg-muted-foreground/40",
};

/** Compact observed-render result for one host row. */
export function LiveRenderRow({ outcome }: { outcome: LiveRenderOutcome }) {
  if (outcome.error) {
    return (
      <div className="mt-2 pl-6 text-xs text-red-600 dark:text-red-400">
        Live render failed: {outcome.error}
      </div>
    );
  }
  const r = outcome.result;
  if (!r) return null;
  const meta = STATUS_META[r.status];
  return (
    <div className="mt-2 space-y-1.5 pl-6 text-xs">
      <div className={`flex items-center gap-1.5 ${TONE_TEXT[meta.tone]}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[meta.tone]}`} />
        <span className="font-medium">Live: {meta.label}</span>
        <span className="text-muted-foreground">
          · {r.elapsedMs}ms · observed
        </span>
      </div>
      {r.hint && <div className="text-muted-foreground">{r.hint}</div>}
      {r.consoleErrors && r.consoleErrors.length > 0 && (
        <div className="text-muted-foreground">
          {r.consoleErrors.length} console error
          {r.consoleErrors.length === 1 ? "" : "s"} —{" "}
          <span className="font-mono">{r.consoleErrors[0]}</span>
          {r.consoleErrors.length > 1
            ? ` +${r.consoleErrors.length - 1}`
            : ""}
        </div>
      )}
      {r.screenshotBase64 && (
        <img
          src={`data:image/png;base64,${r.screenshotBase64}`}
          alt="Live render screenshot"
          className="max-h-40 rounded border border-border/60"
        />
      )}
    </div>
  );
}
