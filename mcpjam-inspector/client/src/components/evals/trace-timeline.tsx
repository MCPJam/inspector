import { useMemo } from "react";
import type { EvalTraceSpan, EvalTraceSpanCategory } from "@/shared/eval-trace";

const ROW_H = 28;
const CHART_H_PAD = 8;
const AXIS_H = 24;

function spanDepth(
  span: EvalTraceSpan,
  byId: Map<string, EvalTraceSpan>,
): number {
  let d = 0;
  let cur: EvalTraceSpan | undefined = span;
  while (cur?.parentId) {
    d += 1;
    cur = byId.get(cur.parentId);
    if (d > 64) break;
  }
  return d;
}

function sortSpansForDisplay(spans: EvalTraceSpan[]): EvalTraceSpan[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  return [...spans].sort((a, b) => {
    const da = spanDepth(a, byId);
    const db = spanDepth(b, byId);
    if (da !== db) return da - db;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.endMs - b.endMs;
  });
}

function categoryBarClass(c: EvalTraceSpanCategory): string {
  switch (c) {
    case "step":
      return "fill-slate-500/85";
    case "llm":
      return "fill-blue-500/85";
    case "tool":
      return "fill-amber-500/85";
    case "error":
      return "fill-red-500/85";
    default:
      return "fill-muted-foreground/60";
  }
}

function formatAxisLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

export interface TraceTimelineProps {
  /** Recorded spans from the trace blob; takes precedence over estimated fallback. */
  recordedSpans?: EvalTraceSpan[] | null;
  /** Wall-clock duration estimate when no spans exist (Convex timestamps only). */
  estimatedDurationMs?: number | null;
  /**
   * When in legacy estimated mode, number of transcript messages (for clearer UX:
   * Chat has detail; Raw shows whether `spans` were persisted).
   */
  transcriptMessageCount?: number;
}

export function TraceTimeline({
  recordedSpans,
  estimatedDurationMs,
  transcriptMessageCount = 0,
}: TraceTimelineProps) {
  const { mode, spans, maxEndMs, legendCategories } = useMemo(() => {
    const hasRecorded = !!(recordedSpans && recordedSpans.length > 0);
    if (hasRecorded) {
      const ordered = sortSpansForDisplay(recordedSpans!);
      const maxEnd = Math.max(
        ...recordedSpans!.map((s) => s.endMs),
        1,
      );
      const cats = new Set(recordedSpans!.map((s) => s.category));
      return {
        mode: "recorded" as const,
        spans: ordered,
        maxEndMs: maxEnd,
        legendCategories: [...cats],
      };
    }
    const est = estimatedDurationMs ?? 0;
    if (est > 0) {
      return {
        mode: "estimated" as const,
        spans: [
          {
            id: "legacy-entire-iteration",
            name: "Entire iteration",
            category: "step" as const,
            startMs: 0,
            endMs: est,
          },
        ] satisfies EvalTraceSpan[],
        maxEndMs: est,
        legendCategories: ["step"] as EvalTraceSpanCategory[],
      };
    }
    return {
      mode: "none" as const,
      spans: [] as EvalTraceSpan[],
      maxEndMs: 0,
      legendCategories: [] as EvalTraceSpanCategory[],
    };
  }, [recordedSpans, estimatedDurationMs]);

  if (mode === "none") {
    return (
      <div className="text-xs text-muted-foreground">
        No timing data recorded for this iteration.
      </div>
    );
  }

  const chartBodyH = spans.length * ROW_H + CHART_H_PAD * 2;
  const totalH = AXIS_H + chartBodyH;
  const innerW = 560;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {mode === "recorded" ? (
          <span className="rounded border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Recorded timing
          </span>
        ) : (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            Estimated total only
          </span>
        )}
        {legendCategories.length > 0 && (
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            {legendCategories.includes("step") && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-slate-500" />
                Step
              </span>
            )}
            {legendCategories.includes("llm") && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-blue-500" />
                LLM
              </span>
            )}
            {legendCategories.includes("tool") && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-amber-500" />
                Tool
              </span>
            )}
            {legendCategories.includes("error") && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-red-500" />
                Error
              </span>
            )}
          </div>
        )}
      </div>

      {mode === "estimated" && (
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>Per-step timing was not recorded for this run.</p>
          {transcriptMessageCount > 0 ? (
            <p>
              Conversation detail is in the Chat tab. Open{" "}
              <span className="font-medium text-foreground/80">Raw</span> to
              inspect the stored trace and confirm whether a{" "}
              <code className="rounded border border-border/50 bg-muted/40 px-1 py-px font-mono text-[10px] text-foreground/90">
                spans
              </code>{" "}
              array exists; only new runs that persist spans show a per-step
              timeline here.
            </p>
          ) : null}
        </div>
      )}

      <div className="overflow-x-auto rounded border border-border/40 bg-muted/10">
        <svg
          width={innerW + 200}
          height={totalH}
          className="min-w-full"
          role="img"
          aria-label="Trace timing"
        >
          <text
            x={200}
            y={14}
            className="fill-muted-foreground text-[10px]"
          >
            {formatAxisLabel(0)}
          </text>
          <text
            x={200 + innerW / 2}
            y={14}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {formatAxisLabel(maxEndMs / 2)}
          </text>
          <text
            x={200 + innerW}
            y={14}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            {formatAxisLabel(maxEndMs)}
          </text>
          <line
            x1={200}
            y1={AXIS_H - 4}
            x2={200 + innerW}
            y2={AXIS_H - 4}
            className="stroke-border/60"
            strokeWidth={1}
          />

          {(() => {
            const byIdForLayout = new Map(spans.map((s) => [s.id, s]));
            return spans.map((span, i) => {
            const depth = spanDepth(span, byIdForLayout);
            const y = AXIS_H + CHART_H_PAD + i * ROW_H;
            const x0 = 200 + (span.startMs / maxEndMs) * innerW;
            const x1 = 200 + (span.endMs / maxEndMs) * innerW;
            const w = Math.max(x1 - x0, 1);
            return (
              <g key={span.id}>
                <text
                  x={8 + depth * 10}
                  y={y + ROW_H / 2 + 4}
                  className="fill-foreground text-[11px] font-mono"
                >
                  {span.name}
                </text>
                <rect
                  x={x0}
                  y={y + 6}
                  width={w}
                  height={ROW_H - 12}
                  rx={1}
                  className={categoryBarClass(span.category)}
                />
              </g>
            );
          });
          })()}
        </svg>
      </div>
    </div>
  );
}
