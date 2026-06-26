import { useCallback, useEffect, useRef, useState } from "react";
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

  // Generation token: bumped on every server switch so an in-flight render from
  // the previous server can't write its result/screenshot under the new one
  // (Chromium renders take seconds — plenty of room to switch mid-flight).
  const genRef = useRef(0);
  useEffect(() => {
    genRef.current += 1;
    setResults({});
    setRunningHostId(null);
  }, [serverName]);

  const available = !isHostedMode() && requirements.hasWidgets;

  /**
   * The widget tool to render FOR A GIVEN HOST. An OpenAI-shim host can render
   * any widget; a non-shim host can't run an OpenAI-only widget (no
   * `window.openai`), so only its MCP-Apps / dual widgets are renderable.
   * `undefined` ⇒ this host can't render any of the server's widgets (the
   * static verdict already covers that), so the caller hides "Run live" rather
   * than producing a misleading render failure.
   */
  const toolFor = useCallback(
    (hostId: string): string | undefined => {
      const { mcpAppsOnly, dual, openaiAppsOnly } = requirements.widgets;
      const candidates = getCompatRuntimeForStyle(hostId).injected
        ? [...mcpAppsOnly, ...dual, ...openaiAppsOnly]
        : [...mcpAppsOnly, ...dual];
      return candidates[0];
    },
    [requirements.widgets],
  );

  const run = useCallback(
    async (report: HostCompatReport) => {
      const tool = toolFor(report.hostId);
      if (!tool) return;
      const injectOpenAiCompat = getCompatRuntimeForStyle(
        report.hostId,
      ).injected;
      const gen = genRef.current;
      setRunningHostId(report.hostId);
      try {
        const result = await renderWidget({
          serverId: serverName,
          toolName: tool,
          injectOpenAiCompat,
        });
        if (genRef.current !== gen) return; // server switched mid-render
        setResults((prev) => withResult(prev, report.hostId, { result }));
      } catch (err) {
        if (genRef.current !== gen) return;
        setResults((prev) =>
          withResult(prev, report.hostId, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        if (genRef.current === gen) setRunningHostId(null);
      }
    },
    [serverName, toolFor],
  );

  return { available, runningHostId, results, run, toolFor };
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
  const meta = STATUS_META[r.status];
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
