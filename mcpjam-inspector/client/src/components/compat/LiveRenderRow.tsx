import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHostedMode } from "@/lib/apis/mode-client";
import { getCompatRuntimeForStyle } from "@/lib/client-styles/registry";
import {
  renderWidget,
  type WidgetRenderResult,
  type WidgetRenderStatus,
} from "@/lib/apis/mcp-widget-render-api";
import { TONE_META, type CompatTone } from "@/components/compat/verdict-meta";
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
 * Keep only the newest render's screenshot resident. Older hosts keep their
 * status/metadata but drop the (potentially hundreds-of-KB) base64 PNG, so
 * running live across many hosts doesn't pile MBs of image data into state.
 */
function withResult(
  prev: Record<string, LiveRenderOutcome>,
  hostId: string,
  outcome: LiveRenderOutcome,
): Record<string, LiveRenderOutcome> {
  const trimmed: Record<string, LiveRenderOutcome> = {};
  for (const [k, v] of Object.entries(prev)) {
    trimmed[k] = v.result?.screenshotBase64
      ? { ...v, result: { ...v.result, screenshotBase64: undefined } }
      : v;
  }
  trimmed[hostId] = outcome;
  return trimmed;
}

/**
 * Tier-2 "observed" apps-lane render. Renders one of the server's widget tools
 * in the local headless harness under a given host's `injectOpenAiCompat`, and
 * tracks the observed status per host. Local-Inspector only (the render route
 * is `!HOSTED_MODE`).
 *
 * v1 renders a single representative widget tool per host.
 */
export function useLiveRenders(
  serverName: string,
  requirements: ServerRequirements,
) {
  const [runningHostId, setRunningHostId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, LiveRenderOutcome>>({});

  /**
   * The widget tool that will be rendered. The local render route renders MCP
   * Apps resources (`_meta.ui.resourceUri`) only — it can't run an OpenAI-only
   * widget (it would just return `no_ui_resource`, misleading "observed"
   * evidence), so OpenAI-only tools are excluded. Dual tools carry a resourceUri
   * too, so they render (with the host's `injectOpenAiCompat` shim when
   * applicable). Host-agnostic: the host only changes the shim flag, not which
   * tool renders. `undefined` ⇒ nothing renderable, so the caller hides "Run
   * live".
   */
  const widgetTool = useMemo(() => {
    const { mcpAppsOnly, dual } = requirements.widgets;
    return [...mcpAppsOnly, ...dual][0];
  }, [requirements.widgets]);

  // Generation token: bumped when the server OR the rendered tool changes, so an
  // in-flight render from a prior server/tool can't write its result/screenshot
  // under the current one (Chromium renders take seconds). A `runningRef` mirrors
  // the in-flight host so a fast double-click can't start parallel jobs before
  // React re-disables the buttons.
  const genRef = useRef(0);
  const runningRef = useRef<string | null>(null);
  useEffect(() => {
    genRef.current += 1;
    runningRef.current = null;
    setResults({});
    setRunningHostId(null);
  }, [serverName, widgetTool]);

  const available = !isHostedMode() && requirements.hasWidgets;

  const run = useCallback(
    async (report: HostCompatReport) => {
      if (!widgetTool) return;
      if (runningRef.current !== null) return; // a render is already in flight
      const injectOpenAiCompat = getCompatRuntimeForStyle(
        report.hostId,
      ).injected;
      const gen = genRef.current;
      runningRef.current = report.hostId;
      setRunningHostId(report.hostId);
      try {
        const result = await renderWidget({
          serverId: serverName,
          toolName: widgetTool,
          injectOpenAiCompat,
        });
        if (genRef.current !== gen) return; // server/tool changed mid-render
        setResults((prev) => withResult(prev, report.hostId, { result }));
      } catch (err) {
        if (genRef.current !== gen) return;
        setResults((prev) =>
          withResult(prev, report.hostId, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        // Only the still-current run clears the in-flight markers; a render
        // abandoned by a server/tool switch leaves them to the reset effect.
        if (genRef.current === gen) {
          runningRef.current = null;
          setRunningHostId(null);
        }
      }
    },
    [serverName, widgetTool],
  );

  return { available, runningHostId, results, run, widgetTool };
}

const STATUS_META: Record<WidgetRenderStatus, { label: string; tone: CompatTone }> =
  {
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
  // Resilient to status drift — a server shipping a new WidgetRenderStatus ahead
  // of the client must not crash the row.
  const meta = STATUS_META[r.status] ?? {
    label: r.status,
    tone: "neutral" as const,
  };
  return (
    <div className="mt-2 space-y-1.5 pl-6 text-xs">
      <div className={`flex items-center gap-1.5 ${TONE_META[meta.tone].text}`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${TONE_META[meta.tone].dot}`}
        />
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
          {r.consoleErrors.length > 1 ? ` +${r.consoleErrors.length - 1}` : ""}
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
