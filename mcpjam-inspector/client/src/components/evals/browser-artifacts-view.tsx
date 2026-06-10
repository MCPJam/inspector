import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Keyboard,
  MonitorOff,
  MousePointerClick,
  Move,
  ScrollText,
  Type,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type {
  EvalTraceBrowserAction,
  EvalTraceBrowserInteractionStepView,
  EvalTraceBrowserStepNote,
  EvalTraceWidgetRenderObservationView,
  EvalTraceWidgetRenderStatus,
  EvalTraceWidgetToolCall,
} from "@/shared/eval-trace";

/**
 * PR 7 — eval replay "Browser" view. Renders what the headless-Chromium harness
 * captured for an iteration:
 *   - widgetRenderObservations: one status card per MCP App widget (the LATEST
 *     render outcome — the backend upserts per toolCallId), with a screenshot.
 *   - browserInteractionSteps: the model-driven Computer Use timeline, grouped
 *     by widget, each step showing its action, screenshot, and any
 *     widget-initiated tools/call.
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
    "Bridge handshake timed out — the widget may have a slow init path.",
  blank_screenshot: "Rendered but painted blank — check console errors.",
  mount_failed: "Failed to mount in the browser.",
  render_error: "Render error during mount.",
  resource_read_failed: "Couldn't fetch the widget HTML.",
  no_ui_resource: "No widget HTML in the tool response.",
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

const ACTION_ICON: Record<EvalTraceBrowserAction, LucideIcon> = {
  screenshot: Clock,
  left_click: MousePointerClick,
  double_click: MousePointerClick,
  right_click: MousePointerClick,
  mouse_move: Move,
  type: Type,
  key: Keyboard,
  scroll: ScrollText,
  wait: Clock,
};

const NOTE_META: Record<EvalTraceBrowserStepNote, { label: string; tone: Tone }> =
  {
    no_rendered_widget: { label: "No rendered widget", tone: "neutral" },
    step_budget_exceeded: { label: "Step budget exceeded", tone: "warning" },
    screenshot_budget_exceeded: {
      label: "Screenshot budget exceeded",
      tone: "warning",
    },
  };

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

function coordinateSuffix(
  step: EvalTraceBrowserInteractionStepView,
): string {
  return step.coordinateX != null && step.coordinateY != null
    ? ` (${step.coordinateX}, ${step.coordinateY})`
    : "";
}

/** One-line human label for a Computer Use action. */
export function formatBrowserAction(
  step: EvalTraceBrowserInteractionStepView,
): string {
  switch (step.action) {
    case "left_click":
      return `Left click${coordinateSuffix(step)}`;
    case "double_click":
      return `Double click${coordinateSuffix(step)}`;
    case "right_click":
      return `Right click${coordinateSuffix(step)}`;
    case "mouse_move":
      return `Mouse move${coordinateSuffix(step)}`;
    case "type":
      return `Type ${JSON.stringify(step.text ?? "")}`;
    case "key":
      return `Key ${step.text ?? ""}`.trim();
    case "scroll":
      return `Scroll ${step.scrollDirection ?? "down"}${
        step.scrollAmount ? ` ×${step.scrollAmount}` : ""
      }`;
    case "wait":
      return `Wait${step.duration ? ` ${step.duration}ms` : ""}`;
    case "screenshot":
      return "Screenshot";
    default:
      return step.action;
  }
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

function WidgetToolCallList({ calls }: { calls: EvalTraceWidgetToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {calls.map((call, i) => (
        <div
          key={`${call.name}-${i}`}
          className="flex items-start gap-1.5 text-[11px]"
        >
          <Badge tone={call.ok ? "success" : "danger"}>
            {call.ok ? "OK" : "ERR"}
          </Badge>
          <span className="min-w-0 break-all font-mono text-muted-foreground">
            {call.name}
            {call.error ? ` — ${call.error}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function RenderObservationCard({
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

function InteractionStepRow({
  step,
}: {
  step: EvalTraceBrowserInteractionStepView;
}) {
  const Icon = ACTION_ICON[step.action] ?? MousePointerClick;
  const note = step.note ? NOTE_META[step.note] : undefined;
  return (
    <div className="flex gap-2" data-testid="interaction-step-row">
      <div className="flex flex-col items-center">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background text-[10px] font-medium text-muted-foreground">
          {step.stepIndex}
        </div>
        <div className="mt-1 w-px flex-1 bg-border/40" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {formatBrowserAction(step)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {step.elapsedMs}ms
          </span>
          {note ? <Badge tone={note.tone}>{note.label}</Badge> : null}
        </div>
        {step.screenshotUrl ? (
          <Screenshot
            url={step.screenshotUrl}
            alt={`step ${step.stepIndex} screenshot`}
          />
        ) : null}
        {step.widgetToolCalls && step.widgetToolCalls.length > 0 ? (
          <WidgetToolCallList calls={step.widgetToolCalls} />
        ) : null}
      </div>
    </div>
  );
}

export function BrowserArtifactsView({
  observations = [],
  steps = [],
  className,
}: {
  observations?: EvalTraceWidgetRenderObservationView[];
  steps?: EvalTraceBrowserInteractionStepView[];
  className?: string;
}) {
  // Map toolCallId → display name so the step timeline can title each group.
  const nameByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const obs of observations) map.set(obs.toolCallId, obs.toolName);
    return map;
  }, [observations]);

  // Group steps into per-widget timelines, preserving the backend's order.
  const stepGroups = useMemo(() => {
    const order: string[] = [];
    const byTool = new Map<string, EvalTraceBrowserInteractionStepView[]>();
    for (const step of steps) {
      if (!byTool.has(step.toolCallId)) {
        byTool.set(step.toolCallId, []);
        order.push(step.toolCallId);
      }
      byTool.get(step.toolCallId)!.push(step);
    }
    return order.map((toolCallId) => ({
      toolCallId,
      steps: byTool.get(toolCallId)!,
    }));
  }, [steps]);

  if (observations.length === 0 && steps.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border/40 py-8 text-xs text-muted-foreground"
        data-testid="browser-artifacts-empty"
      >
        No browser-rendered widgets in this iteration.
      </div>
    );
  }

  return (
    <div
      className={cn("flex min-h-0 flex-col gap-4 overflow-auto", className)}
      data-testid="browser-artifacts-view"
    >
      {observations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Render observations
            <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
              latest render per widget
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

      {stepGroups.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Computer Use timeline
          </h3>
          <div className="flex flex-col gap-3">
            {stepGroups.map((group) => (
              <div
                key={group.toolCallId}
                className="rounded-md border border-border/40 bg-muted/10 p-3"
                data-testid="interaction-step-group"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="truncate font-mono text-xs font-medium">
                    {nameByToolCallId.get(group.toolCallId) ?? group.toolCallId}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {group.steps.length} step
                    {group.steps.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-col">
                  {group.steps.map((step) => (
                    <InteractionStepRow
                      key={`${step.toolCallId}-${step.stepIndex}`}
                      step={step}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
