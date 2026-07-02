import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  MonitorOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  EvalTraceWidgetRenderObservationView,
  EvalTraceWidgetRenderStatus,
} from "@/shared/eval-trace";

/**
 * Eval replay "App" view. Renders the iteration-level artifacts the
 * headless-Chromium harness captured that are NOT recoverable elsewhere:
 *   - videoUrl: the `.webm` replay player.
 *   - widgetRenderObservations: one status card per MCP App (the LATEST
 *     render outcome — the backend upserts per toolCallId), with a screenshot.
 *
 * The per-step Computer Use / scripted interaction timeline is NOT rendered
 * here anymore: it lives on the Trace tab as `Interact · …` spans (same
 * `browserInteractionSteps` source), which is the canonical step view —
 * screenshots, verdicts, coordinates, and the triggered widget tool calls all
 * hang off each span. See `trace-timeline.tsx`.
 */

type Tone = "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-border/50 bg-muted/40 text-muted-foreground",
};

const STATUS_META: Record<
  EvalTraceWidgetRenderStatus,
  { label: string; tone: Tone; Icon: LucideIcon }
> = {
  rendered: { label: "Rendered", tone: "success", Icon: CheckCircle2 },
  blank_screenshot: {
    label: "Blank screenshot",
    tone: "warning",
    Icon: AlertTriangle,
  },
  bridge_timeout: { label: "Bridge timeout", tone: "warning", Icon: Clock },
  no_ui_resource: { label: "No UI resource", tone: "neutral", Icon: Ban },
  resource_read_failed: {
    label: "Resource read failed",
    tone: "danger",
    Icon: XCircle,
  },
  mount_failed: { label: "Mount failed", tone: "danger", Icon: XCircle },
  render_error: { label: "Render error", tone: "danger", Icon: XCircle },
  screenshot_failed: {
    label: "Screenshot failed",
    tone: "danger",
    Icon: XCircle,
  },
  browser_unavailable: {
    label: "Browser unavailable",
    tone: "neutral",
    Icon: MonitorOff,
  },
};

// Plain-language "why did it fail?" copy shown under the badge. `rendered` needs
// no explanation; `render_error` prefers the first console error when present.
const STATUS_DESCRIPTION: Record<
  EvalTraceWidgetRenderStatus,
  string | undefined
> = {
  rendered: undefined,
  bridge_timeout:
    "Bridge handshake timed out — the app may have a slow init path.",
  blank_screenshot: "Rendered but painted blank — check console errors.",
  mount_failed: "Failed to mount the app in the browser.",
  render_error: "Render error during mount.",
  resource_read_failed: "Couldn't fetch the app HTML.",
  no_ui_resource: "No app HTML in the tool response.",
  screenshot_failed: "Rendered, but screenshot capture failed.",
  browser_unavailable: "Browser sandbox unavailable (Chromium not installed).",
};

function statusDescription(
  observation: EvalTraceWidgetRenderObservationView,
): string | undefined {
  if (observation.status === "render_error") {
    return observation.consoleErrors?.[0] ?? STATUS_DESCRIPTION.render_error;
  }
  return STATUS_DESCRIPTION[observation.status];
}

function Badge({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

function Screenshot({ url, alt }: { url?: string | null; alt: string }) {
  if (!url) {
    return (
      <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed border-border/50 bg-muted/20 text-[11px] text-muted-foreground">
        No screenshot
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="max-h-64 w-full rounded-md border border-border/40 bg-background object-contain object-top"
    />
  );
}

/**
 * One MCP App's latest render outcome — status, timing, screenshot,
 * resource URI, and console errors. Exported so the predicate gate can render it
 * inline as the evidence behind a `widgetRendered` / `widgetRenderLatencyUnder`
 * / `widgetNoConsoleErrors` assertion (same per-widget data the assertion
 * grades on).
 */
export function RenderObservationCard({
  observation,
}: {
  observation: EvalTraceWidgetRenderObservationView;
}) {
  const meta = STATUS_META[observation.status] ?? {
    label: observation.status,
    tone: "neutral" as Tone,
    Icon: Ban,
  };
  const { Icon } = meta;
  const description = statusDescription(observation);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border/40 bg-muted/10 p-3"
      data-testid="render-observation-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium">
            {observation.toolName}
          </span>
          <Badge tone={meta.tone}>
            <Icon className="h-3 w-3" aria-hidden />
            {meta.label}
          </Badge>
        </div>
        <span className="text-[11px] text-muted-foreground">
          turn {observation.promptIndex + 1} · {observation.elapsedMs}ms
        </span>
      </div>

      {description ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="render-observation-description"
        >
          {description}
        </p>
      ) : null}

      <Screenshot
        url={observation.screenshotUrl}
        alt={`${observation.toolName} render`}
      />

      {observation.resourceUri ? (
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {observation.resourceUri}
        </div>
      ) : null}

      {observation.consoleErrors && observation.consoleErrors.length > 0 ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-red-500">
            {observation.consoleErrors.length} console error
            {observation.consoleErrors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {observation.consoleErrors.map((err, i) => (
              <li
                key={i}
                className="break-all font-mono text-muted-foreground"
              >
                {err}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function BrowserArtifactsView({
  observations = [],
  videoUrl = null,
  className,
}: {
  observations?: EvalTraceWidgetRenderObservationView[];
  /** Iteration replay `.webm` URL; renders a "Replay" player when present. */
  videoUrl?: string | null;
  className?: string;
}) {
  if (observations.length === 0 && !videoUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border/40 py-8 text-xs text-muted-foreground"
        data-testid="browser-artifacts-empty"
      >
        No MCP Apps in this iteration.
      </div>
    );
  }

  return (
    <div
      className={cn("flex min-h-0 flex-col gap-4 overflow-auto", className)}
      data-testid="browser-artifacts-view"
    >
      {videoUrl ? (
        <section className="flex flex-col gap-2" data-testid="browser-replay">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Replay
            <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
              screen recording of MCP App interactions during this run
            </span>
          </h3>
          <video
            src={videoUrl}
            controls
            preload="metadata"
            className="w-full rounded-md border border-border/60 bg-black"
            data-testid="browser-replay-video"
          />
        </section>
      ) : null}
      {observations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Render check
            <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
              screenshot and status for each MCP App the agent invoked
            </span>
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {observations.map((obs) => (
              <RenderObservationCard
                key={`${obs.toolCallId}-${obs.ts}`}
                observation={obs}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
