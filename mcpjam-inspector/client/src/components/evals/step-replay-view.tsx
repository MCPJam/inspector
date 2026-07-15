import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Gavel,
  Loader2,
  MessageSquare,
  MousePointerClick,
  MinusCircle,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  type AssertStep,
  type InteractStep,
  type TestStep,
} from "@/shared/steps";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import { RenderObservationCard } from "./browser-artifacts-view";

/** Settled (or in-flight) iteration verdict shown atop the step list. */
export type StepVerdict = "passed" | "failed" | "pending" | "cancelled";

/**
 * Step-aligned replay: ONE row per authored `TestStep`, in order, mirroring the
 * left-pane step list. Each row shows that step's own recorded artifact + verdict
 * — the visible answer to "everything in the left reflected on the right".
 *
 * Artifacts are bucketed by `authoredStepId` (stamped by the unified step
 * executor, W1). Runs predating that field carry no `authoredStepId`, so their
 * rows render structure-only (no artifacts) rather than mis-attributing — the
 * Trace/App tabs remain the fallback for legacy runs.
 *
 * Deliberately host-frozen: this consumes the recorded screenshots/observations
 * (via {@link RenderObservationCard}), never the live host-aware widget renderer
 * (`WidgetReplay`/`MCPAppsRenderer`), so the replay stays faithful to the host
 * the run actually executed under.
 */

const KIND_META: Record<
  TestStep["kind"],
  { label: string; Icon: LucideIcon; tint: string }
> = {
  prompt: {
    label: "Prompt",
    Icon: MessageSquare,
    tint: "text-sky-600 dark:text-sky-400",
  },
  toolCall: {
    label: "Tool call",
    Icon: Wrench,
    tint: "text-violet-600 dark:text-violet-400",
  },
  interact: {
    label: "Interact",
    Icon: MousePointerClick,
    tint: "text-amber-600 dark:text-amber-400",
  },
  assert: {
    label: "Assertion",
    Icon: Gavel,
    tint: "text-indigo-600 dark:text-indigo-400",
  },
};

type StatusTone = "ok" | "fail" | "running" | "skipped" | "unknown";

const STATUS_META: Record<
  StatusTone,
  { label: string; Icon: LucideIcon; cls: string }
> = {
  ok: {
    label: "Passed",
    Icon: CheckCircle2,
    cls: "text-emerald-600 dark:text-emerald-400",
  },
  fail: {
    label: "Failed",
    Icon: XCircle,
    cls: "text-red-600 dark:text-red-400",
  },
  running: {
    label: "Running",
    Icon: Loader2,
    cls: "text-muted-foreground animate-spin",
  },
  skipped: {
    label: "Skipped",
    Icon: MinusCircle,
    cls: "text-muted-foreground",
  },
  unknown: { label: "", Icon: CircleDashed, cls: "text-muted-foreground/50" },
};

function statusTone(status: EvalStepStatus | undefined): StatusTone {
  if (status === "ok") return "ok";
  if (status === "fail") return "fail";
  if (status === "running") return "running";
  if (status === "skipped") return "skipped";
  return "unknown";
}

/** One-line human summary of the step's intent for the row header. */
function stepSummary(step: TestStep): string {
  if (isPromptStep(step)) return step.prompt;
  if (isToolCallStep(step)) return `call ${step.toolName}`;
  if (isInteractStep(step)) return describeInteract(step);
  if (isAssertStep(step)) return describeAssert(step);
  return "";
}

function describeInteract(step: InteractStep): string {
  const a = step.action;
  switch (a.kind) {
    case "click":
      return `click ${describeTarget(a.target)} · ${step.toolName}`;
    case "type":
      return `type "${a.text}" into ${describeTarget(a.target)}`;
    case "key":
      return `key ${a.key}`;
    case "scroll":
      return `scroll ${a.direction}`;
    case "wait":
      return `wait ${a.ms}ms`;
  }
}

function describeTarget(t: {
  testId?: string;
  role?: { role: string; name?: string };
  text?: string;
  css?: string;
}): string {
  if (t.testId) return `#${t.testId}`;
  if (t.role) return `${t.role.role}${t.role.name ? ` "${t.role.name}"` : ""}`;
  if (t.text) return `"${t.text}"`;
  if (t.css) return t.css;
  return "element";
}

function describeAssert(step: AssertStep): string {
  const a = step.assertion;
  if (isWidgetAssertion(a)) return a.kind;
  // Transcript predicate — `type` plus its most identifying field.
  const p = a as { type: string; toolName?: string };
  return p.toolName ? `${p.type}: ${p.toolName}` : p.type;
}

export function StepReplayView({
  steps,
  renderObservations = [],
  interactionSteps = [],
  stepStatusById,
  verdict = null,
  selectedStepId,
  hoveredStepId,
  onHoverStep,
  onSelectStep,
  className,
}: {
  steps: TestStep[];
  renderObservations?: EvalTraceWidgetRenderObservationView[];
  interactionSteps?: EvalTraceBrowserInteractionStepView[];
  /** Live/persisted per-step verdict (keyed by `TestStep.id`). */
  stepStatusById?: Map<string, EvalStepStatus>;
  /** Authoritative iteration result; renders the verdict header when present.
   *  (The advisory judge verdict is pinned above the tab row by the caller, so
   *  this header carries only the deterministic pass/fail + check tally.) */
  verdict?: StepVerdict | null;
  selectedStepId?: string | null;
  hoveredStepId?: string | null;
  onHoverStep?: (stepId: string | null) => void;
  onSelectStep?: (stepId: string | null) => void;
  className?: string;
}) {
  const obsByStep = bucketBy(renderObservations);
  const intsByStep = bucketBy(interactionSteps);

  // Tally the authored assertions (the "checks") and how many passed, derived
  // from the same per-step status the rows below render — so the header and the
  // rows can never disagree.
  const checkStatuses = steps
    .filter(isAssertStep)
    .map((s) => resolveStatus(s, intsByStep.get(s.id), stepStatusById));
  const checkTotal = checkStatuses.length;
  const checksPassed = checkStatuses.filter((s) => s === "ok").length;
  const checksFailed = checkStatuses.filter((s) => s === "fail").length;

  // The full screen recording lives on the App tab ("REPLAY"); Steps shows the
  // per-step artifacts inline, so it doesn't repeat the video here.

  return (
    <div
      className={cn("flex flex-col gap-2 p-3", className)}
      data-testid="step-replay-view"
    >
      {verdict ? (
        <StepsVerdictHeader
          verdict={verdict}
          checkTotal={checkTotal}
          checksPassed={checksPassed}
          checksFailed={checksFailed}
        />
      ) : null}
      {steps.map((step, i) => {
        const meta = KIND_META[step.kind];
        const status = resolveStatus(
          step,
          intsByStep.get(step.id),
          stepStatusById
        );
        const tone = statusTone(status);
        const sMeta = STATUS_META[tone];
        const obs = obsByStep.get(step.id) ?? [];
        const ints = intsByStep.get(step.id) ?? [];
        const active =
          selectedStepId === step.id || hoveredStepId === step.id;
        return (
          <div
            key={step.id}
            data-testid="step-replay-row"
            data-step-id={step.id}
            onMouseEnter={() => onHoverStep?.(step.id)}
            onMouseLeave={() => onHoverStep?.(null)}
            onClick={() => onSelectStep?.(step.id)}
            className={cn(
              "rounded-lg border bg-background/40 transition-colors",
              active ? "border-primary/50 bg-primary/5" : "border-border/50",
              onSelectStep && "cursor-pointer"
            )}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <meta.Icon className={cn("h-3.5 w-3.5 shrink-0", meta.tint)} />
              <span className="shrink-0 text-xs font-medium text-foreground">
                {meta.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {stepSummary(step)}
              </span>
              {tone !== "unknown" ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-[11px]",
                    sMeta.cls
                  )}
                  title={sMeta.label}
                >
                  <sMeta.Icon className="h-3.5 w-3.5" />
                </span>
              ) : (
                <CircleDot className="h-3 w-3 shrink-0 text-muted-foreground/30" />
              )}
            </div>

            {(obs.length > 0 || ints.length > 0) && (
              <div className="flex flex-col gap-2 px-3 pb-3">
                {isPromptStep(step) ? (
                  // A `prompt` turn's views/interactions come from tool calls the
                  // MODEL chose — calls with no authored step of their own. Per
                  // SEP-1865 a view belongs to the `tools/call` that instantiated
                  // it, so group by `toolCallId` to show prompt → call → view
                  // rather than floating the view at the prompt level.
                  groupArtifactsByToolCall(obs, ints).map((g) => (
                    <ToolCallArtifactGroup key={g.toolCallId} group={g} />
                  ))
                ) : (
                  // Other kinds (`toolCall`/`interact`) are themselves a single
                  // call, already named in the row header — render flat.
                  <>
                    {obs.map((o) => (
                      <RenderObservationCard
                        key={`obs-${o.toolCallId}-${o.ts}`}
                        observation={o}
                      />
                    ))}
                    {ints.map((s) => (
                      <InteractionRow
                        key={`int-${s.toolCallId}-${s.stepIndex}`}
                        step={s}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Map an iteration verdict to the shared status tone vocabulary + a label. */
function verdictMeta(verdict: StepVerdict | null): {
  label: string;
  Icon: LucideIcon;
  cls: string;
} {
  switch (verdict) {
    case "passed":
      return { ...STATUS_META.ok, label: "Passed" };
    case "failed":
      return { ...STATUS_META.fail, label: "Failed" };
    case "pending":
      return { ...STATUS_META.running, label: "Running" };
    case "cancelled":
      return { ...STATUS_META.skipped, label: "Cancelled" };
    default:
      return { ...STATUS_META.unknown, label: "Not run" };
  }
}

/**
 * Overall deterministic verdict for the iteration, sitting atop the step list —
 * the answer to "did it pass, and how many checks held" before you scan the
 * per-step rows below. The advisory LLM judge verdict is pinned separately above
 * the tab row by the caller, so it is intentionally not repeated here.
 */
function StepsVerdictHeader({
  verdict,
  checkTotal,
  checksPassed,
  checksFailed,
}: {
  verdict: StepVerdict;
  checkTotal: number;
  checksPassed: number;
  checksFailed: number;
}) {
  const meta = verdictMeta(verdict);
  return (
    <div
      data-testid="steps-verdict-header"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 bg-muted/15 px-3 py-2"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <meta.Icon className={cn("size-4", meta.cls)} aria-hidden />
        <span className={cn("text-sm font-semibold", meta.cls)}>
          {meta.label}
        </span>
      </span>

      {checkTotal > 0 ? (
        <span className="text-xs text-muted-foreground">
          {checksPassed} of {checkTotal} check{checkTotal === 1 ? "" : "s"} passed
          {checksFailed > 0 ? (
            <span className="text-red-600 dark:text-red-400">
              {" "}
              · {checksFailed} failed
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** A model-driven tool call's artifacts, grouped under a `prompt` turn. */
type ToolCallArtifacts = {
  toolCallId: string;
  /** The tool that issued the call (from a render observation; interactions
   *  carry only `toolCallId`, so a call with interactions but no render shows
   *  none). */
  toolName?: string;
  /** Earliest artifact timestamp — orders calls chronologically within the turn. */
  firstTs: number;
  observations: EvalTraceWidgetRenderObservationView[];
  interactions: EvalTraceBrowserInteractionStepView[];
};

/**
 * Group a `prompt` turn's artifacts by the tool call that produced them. The
 * model's tool calls have no authored step of their own, so the executor stamps
 * their renders/interactions with the prompt step's id (they bucket onto the
 * prompt). Re-grouping by `toolCallId` restores SEP-1865's prompt → call → view
 * hierarchy: every view is attributed to the call that instantiated it, which is
 * guaranteed to exist (unlike an optional matching assertion). Ordered by first
 * artifact time so the calls read in the sequence the model made them.
 */
function groupArtifactsByToolCall(
  observations: EvalTraceWidgetRenderObservationView[],
  interactions: EvalTraceBrowserInteractionStepView[]
): ToolCallArtifacts[] {
  const byId = new Map<string, ToolCallArtifacts>();
  const ensure = (toolCallId: string, ts: number, toolName?: string) => {
    let g = byId.get(toolCallId);
    if (!g) {
      g = {
        toolCallId,
        toolName,
        firstTs: ts,
        observations: [],
        interactions: [],
      };
      byId.set(toolCallId, g);
    } else {
      if (!g.toolName && toolName) g.toolName = toolName;
      if (ts < g.firstTs) g.firstTs = ts;
    }
    return g;
  };
  for (const o of observations) {
    ensure(o.toolCallId, o.ts, o.toolName).observations.push(o);
  }
  for (const s of interactions) {
    ensure(s.toolCallId, s.ts).interactions.push(s);
  }
  return Array.from(byId.values()).sort((a, b) => a.firstTs - b.firstTs);
}

/**
 * One model tool call within a prompt turn: a thin "Tool call · <name>" header
 * over a left rail, with the call's rendered view(s) and interaction(s) nested
 * underneath. The rail makes the view read as the call's artifact, not the
 * prompt's.
 */
function ToolCallArtifactGroup({ group }: { group: ToolCallArtifacts }) {
  return (
    <div
      className="ml-1 flex flex-col gap-2 border-l-2 border-border/40 pl-3"
      data-testid="step-tool-call-group"
      data-tool-call-id={group.toolCallId}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="font-medium text-foreground">Tool call</span>
        {group.toolName ? (
          <span className="truncate font-mono">{group.toolName}</span>
        ) : null}
      </div>
      {group.observations.map((o) => (
        <RenderObservationCard
          key={`obs-${o.toolCallId}-${o.ts}`}
          observation={o}
        />
      ))}
      {group.interactions.map((s) => (
        <InteractionRow key={`int-${s.toolCallId}-${s.stepIndex}`} step={s} />
      ))}
    </div>
  );
}

/** Compact render of one recorded interaction artifact (screenshot + effects). */
function InteractionRow({
  step,
}: {
  step: EvalTraceBrowserInteractionStepView;
}) {
  const ok = step.assertion ? step.assertion.passed : step.ok;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-mono text-muted-foreground">
          {step.action}
          {step.locatorLabel ? ` · ${step.locatorLabel}` : ""}
        </span>
        {ok === false ? (
          <span className="shrink-0 text-red-600 dark:text-red-400">
            failed
          </span>
        ) : ok === true ? (
          <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
            ok
          </span>
        ) : null}
      </div>

      {step.assertion?.reason ? (
        <p className="text-[11px] text-muted-foreground">
          {step.assertion.reason}
        </p>
      ) : null}

      {step.screenshotUrl ? (
        <img
          src={step.screenshotUrl}
          alt={`${step.action} step`}
          className="w-full rounded border border-border/60"
        />
      ) : null}

      {step.widgetToolCalls && step.widgetToolCalls.length > 0 ? (
        <div className="flex flex-col gap-0.5 text-[11px]">
          {step.widgetToolCalls.map((c, i) => (
            <span key={i} className="truncate font-mono text-muted-foreground">
              ↳ fired {c.name}
              {c.ok === false ? " (failed)" : ""}
            </span>
          ))}
        </div>
      ) : null}

      {step.followUps && step.followUps.length > 0 ? (
        <div className="flex flex-col gap-0.5 text-[11px]">
          {step.followUps.map((text, i) => (
            <span key={i} className="truncate text-muted-foreground">
              ↳ sent message: {text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function bucketBy<T extends { authoredStepId?: string }>(
  rows: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.authoredStepId) continue;
    const list = map.get(row.authoredStepId);
    if (list) list.push(row);
    else map.set(row.authoredStepId, [row]);
  }
  return map;
}

/** Per-step verdict: prefer the live/persisted status; else derive from the
 *  step's own recorded artifacts (an assert's DOM verdict, an interact's ok). */
function resolveStatus(
  step: TestStep,
  ints: EvalTraceBrowserInteractionStepView[] | undefined,
  stepStatusById?: Map<string, EvalStepStatus>
): EvalStepStatus | undefined {
  const live = stepStatusById?.get(step.id);
  if (live) return live;
  const rows = ints ?? [];
  if (isAssertStep(step)) {
    const verdict = rows.find((r) => r.assertion);
    if (verdict?.assertion) return verdict.assertion.passed ? "ok" : "fail";
  }
  if (isInteractStep(step) && rows.length > 0) {
    return rows.every((r) => r.ok !== false) ? "ok" : "fail";
  }
  return undefined;
}
