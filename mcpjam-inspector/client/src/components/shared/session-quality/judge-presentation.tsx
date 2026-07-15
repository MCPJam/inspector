import { useState } from "react";
import { ChevronDown, Gavel } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Product-neutral LLM-judge presentation.
 *
 * The generic pieces of "what a goal-completion judge verdict looks like" —
 * score formatting, the pass/fail badge, the reason parser, and the
 * expandable verdict panel — extracted from
 * `components/evals/goal-completion-presentation.tsx` so non-eval surfaces
 * (the Swarms session viewer grades sessions with the same backend judge)
 * render identical verdicts without importing eval-shaped types. The evals
 * module re-exports these and keeps its `JudgeCase`-shaped adapters; Swarms
 * adapts its denormalized `goalScore` records.
 */

/**
 * The judge prefixes objective-mode reasons with "no rubric:" — internal
 * jargon for the lower-confidence (≤85%) mode used when grading without an
 * expected output. Parse it out so the UI shows a friendly tag and a clean
 * reason instead of leaking the prefix.
 */
const NO_RUBRIC_PREFIX = /^\s*no rubric\s*[:—-]\s*/i;
export function parseJudgeReason(reason: string | undefined): {
  noRubric: boolean;
  text: string;
} {
  const raw = reason ?? "";
  return {
    noRubric: NO_RUBRIC_PREFIX.test(raw),
    text: raw.replace(NO_RUBRIC_PREFIX, "").trim(),
  };
}

export function formatScore(score: number): string {
  // Don't route the score through clampThreshold: its NaN→DEFAULT_THRESHOLD
  // fallback is right for the threshold input but would render a corrupt/NaN
  // score as "70%" (the pass cutoff). Show a neutral dash instead, and clamp
  // finite scores into [0,1].
  if (!Number.isFinite(score)) {
    return "—";
  }
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

export function ScoreBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        passed
          ? "bg-success/50 text-foreground"
          : "bg-warning/50 text-foreground",
      )}
    >
      {passed ? "meets goal" : "below threshold"}
    </span>
  );
}

/** The generic verdict shape every judge surface shares. */
export type JudgeVerdict = {
  score: number;
  passed: boolean;
  reason?: string;
};

/**
 * Compact, always-visible advisory judge verdict panel. One line: gavel +
 * score + verdict badge + a one-line reason preview; click to expand the full
 * reason. Product-neutral core of the evals `JudgeVerdictPanel` (which adapts
 * its `JudgeCase` onto this) — the Swarms session viewer adapts its
 * denormalized `goalScore` the same way.
 */
export function JudgeVerdictCard({ verdict }: { verdict: JudgeVerdict }) {
  const { noRubric, text: reason } = parseJudgeReason(verdict.reason);
  const canExpand = Boolean(reason);
  const [expanded, setExpanded] = useState(false);

  const header = (
    <>
      <Gavel className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium uppercase tracking-wide text-muted-foreground">
        Judge · advisory
      </span>
      <span className="font-semibold tabular-nums text-foreground">
        {formatScore(verdict.score)}
      </span>
      <ScoreBadge passed={verdict.passed} />
      {noRubric ? (
        <span
          className="shrink-0 rounded-sm bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          title="No expected output or assertions to grade against — graded loosely against the request, score capped at 85%. Add assertions or an Expected Output for stricter grading."
        >
          no expected output
        </span>
      ) : null}
      {canExpand && !expanded ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {reason}
        </span>
      ) : null}
      {canExpand ? (
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      ) : null}
    </>
  );

  return (
    <div className="shrink-0 rounded-lg border border-border/50 bg-muted/15 text-xs">
      {canExpand ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/25"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse judge reason" : "Expand judge reason"
          }
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{header}</div>
      )}
      {canExpand && expanded ? (
        <div className="border-t border-border/40 px-3 py-2 text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {reason}
        </div>
      ) : null}
    </div>
  );
}
