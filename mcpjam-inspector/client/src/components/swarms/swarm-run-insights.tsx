/**
 * Swarm run insights — the answer, above the fold.
 *
 * ONE list, not two. The deterministic miner and the model are two lanes over
 * the same problems, so rendering them as separate sections produced the same
 * finding twice in different words. Here each row is a SIGNAL — precise,
 * instant, backend-computed — that the model's explanation enriches when it
 * arrives. Nothing waits on generation to be readable, and nothing is said
 * twice.
 *
 * Collapsed rows are one line each so the whole picture fits without
 * scrolling; cause, fix, and evidence live behind the expand. Caveats
 * (coverage, partial analysis) sit in a single muted footer rather than
 * opening the summary, because a reader scanning for what to fix should not
 * have to read past a disclaimer to reach it.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  SWARM_MUTATIONS,
  SWARM_QUERIES,
  type SwarmFinding,
  type SwarmWaveDiscovery,
  type SwarmWaveInsightCandidate,
  type SwarmWaveSignalCandidate,
  type SwarmWaveSignals,
} from "@/lib/swarm-api";
import { useSwarmRunInsights } from "@/hooks/use-swarm-run-insights";

/** Rows visible before "Show all" — enough to see the shape of the run. */
const VISIBLE_ROWS = 3;

/**
 * Summary length that fits the rail without pushing the rows out of view.
 * Past it the text clamps to two lines behind a "more" toggle — the same
 * treatment the evals insight banner uses, and the reason the previous layout
 * showed a sentence cut off mid-word.
 */
const SUMMARY_CLAMP_CHARS = 150;

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  new: {
    label: "New",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  recurring: {
    label: "Recurring",
    className:
      "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  regressed: {
    label: "Regressed",
    className:
      "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  resolved: {
    label: "Resolved",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
};

/**
 * Mirror of `buildFindingFingerprint` in
 * `convex/lib/swarmFindingFingerprint.ts` — the join key between a live
 * signal, its generated explanation, and its registry row. Kept in lockstep
 * by hand (two-repo layout); a drift here shows up as rows that never enrich.
 */
export function signalFingerprint(candidate: {
  detector: string;
  subjectKind: string;
  subjectId: string;
}): string {
  const clean = (value: string) => value.replace(/[:\n]/g, "_");
  return `${clean(candidate.detector)}:${clean(candidate.subjectKind)}:${clean(
    candidate.subjectId,
  )}`.slice(0, 200);
}

/**
 * One deterministic sentence per detector. Counts come from the candidate
 * verbatim — phrasing is the ONLY thing this layer adds, and it is what the
 * model is explicitly forbidden from restating.
 */
export function signalSentence(c: SwarmWaveSignalCandidate): string {
  switch (c.detector) {
    case "tool_errors":
      return `${c.subjectLabel} failed ${c.metric ?? c.affectedSessions}× across ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "hallucinated_tool":
      return `Agents invented a tool named "${c.subjectLabel}" in ${c.affectedSessions} ${plural(c.affectedSessions, "session")}`;
    case "criterion_fail":
      return `"${c.subjectLabel}" failed in ${c.affectedSessions} of ${c.sliceTotal} graded sessions`;
    case "target_failures":
      return `Failures concentrate on ${c.subjectLabel} (${c.affectedSessions} of ${c.sliceTotal})`;
    case "persona_struggles":
      return `${c.subjectLabel} struggled in ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "marginal_pass":
      return `${c.affectedSessions} ${plural(c.affectedSessions, "pass", "passes")} in "${c.subjectLabel}" barely cleared the judge threshold`;
    case "turn_cap_grind":
      return `${c.affectedSessions} ${plural(c.affectedSessions, "session")} in "${c.subjectLabel}" ran out the ${c.metric ?? "max"}-turn budget`;
    case "error_recovered_pass":
      return `${c.affectedSessions} passing ${plural(c.affectedSessions, "session")} in "${c.subjectLabel}" recovered from tool errors first`;
    case "token_outlier":
      return `"${c.subjectLabel}" uses ~${ratioLabel(c)} the tokens of the rest of the run`;
    case "latency_outlier":
      return `${c.subjectLabel} p95 latency is ${ratioLabel(c)} the rest of the run`;
    case "no_tools_used":
      return `${c.affectedSessions} ${plural(c.affectedSessions, "session")} in "${c.subjectLabel}" never called a tool`;
    default:
      return `${c.subjectLabel}: ${c.affectedSessions} of ${c.sliceTotal} sessions`;
  }
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function ratioLabel(c: SwarmWaveSignalCandidate): string {
  if (
    typeof c.metric !== "number" ||
    typeof c.waveMetric !== "number" ||
    c.waveMetric <= 0
  ) {
    return "well above";
  }
  return `${(c.metric / c.waveMetric).toFixed(1)}×`;
}

/** Hallucinated tools and failing criteria are the load-bearing problems. */
function isBlockingShaped(detector: string): boolean {
  return detector === "hallucinated_tool" || detector === "criterion_fail";
}

type Row = {
  fingerprint: string;
  signal: SwarmWaveSignalCandidate;
  insight?: SwarmWaveInsightCandidate;
  finding?: SwarmFinding;
};

export function SwarmRunInsights({
  projectId,
  swarmRunGroupId,
  onOpenSession,
}: {
  projectId: string;
  /** Durable run id — the parent renders this only when present. */
  swarmRunGroupId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const signals = useQuery(
    SWARM_QUERIES.getWaveSignals as any,
    { projectId, swarmRunGroupId } as any,
  ) as SwarmWaveSignals | null | undefined;
  const terminal = signals?.terminal === true;
  // Nothing concentrated anywhere means there is nothing to explain, so a
  // clean run never spends a model call — "no anomalies" IS the answer.
  const hasSignals = (signals?.candidates.length ?? 0) > 0;

  const { insights, discovery, busy, unavailable, error, request } =
    useSwarmRunInsights(projectId, swarmRunGroupId, {
      terminal,
      autoRequest: hasSignals,
    });
  const findings = useQuery(
    SWARM_QUERIES.listSwarmFindings as any,
    { projectId } as any,
  ) as SwarmFinding[] | undefined;

  const [showAll, setShowAll] = useState(false);
  // Resolved registry rows are history — default to open problems so the
  // panel answers "what still matters" instead of replaying green chips.
  const [showResolved, setShowResolved] = useState(false);

  const rows: Row[] = useMemo(() => {
    if (!signals) return [];
    const insightBy = new Map(
      (insights?.candidates ?? []).map((c) => [c.fingerprint, c]),
    );
    const findingBy = new Map((findings ?? []).map((f) => [f.fingerprint, f]));
    return signals.candidates.map((signal) => {
      const fingerprint = signalFingerprint(signal);
      return {
        fingerprint,
        signal,
        insight: insightBy.get(fingerprint),
        finding: findingBy.get(fingerprint),
      };
    });
  }, [signals, insights, findings]);

  const resolvedCount = rows.filter(
    (row) => row.finding?.status === "resolved",
  ).length;
  const filteredRows = showResolved
    ? rows
    : rows.filter((row) => row.finding?.status !== "resolved");

  // Loading, unknown run, or a backend without the feature: render nothing
  // rather than a broken block.
  if (!signals) return null;
  if (!terminal) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="swarm-run-insights-pending-run"
      >
        Insights appear when the run finishes.
      </p>
    );
  }
  if (rows.length === 0 && !busy) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="swarm-run-insights-empty"
      >
        No anomalies detected across {signals.sessionCount} sessions.
      </p>
    );
  }

  const visible = showAll
    ? filteredRows
    : filteredRows.slice(0, VISIBLE_ROWS);
  const caveats: string[] = [];
  if (signals.judgeCoverage.graded === 0 && signals.judgeCoverage.total > 0) {
    caveats.push("no judge verdicts — goal completion not assessed");
  }
  if (signals.lowConfidence) caveats.push("most sessions still analyzing");
  if (signals.truncated) caveats.push("newest sessions only");
  if (insights && insights.unnarratedCandidates.length > 0) {
    caveats.push(`${insights.unnarratedCandidates.length} more not explained`);
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col rounded-lg border border-border/60 bg-muted/20"
      data-testid="swarm-run-insights"
    >
      <div className="space-y-1 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xs font-medium">Where sessions struggled</h3>
            <p className="truncate text-[11px] text-muted-foreground">
              Patterns across this run
            </p>
          </div>
          {resolvedCount > 0 ? (
            <button
              type="button"
              className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowResolved((prev) => !prev)}
              data-testid="swarm-run-insights-resolved-toggle"
            >
              {showResolved
                ? "Hide resolved"
                : `Show resolved (${resolvedCount})`}
            </button>
          ) : null}
        </div>
        {/* LLM status is enrichment only — never a competing banner over the
            deterministic rows. */}
        {busy || error || insights?.summary ? (
          <div className="flex items-start gap-2">
            {busy ? (
              <p
                className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground"
                data-testid="swarm-run-insights-generating"
              >
                <Loader2 className="size-3 animate-spin" />
                Explaining…
              </p>
            ) : error ? (
              <p
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground"
                data-testid="swarm-run-insights-error"
              >
                <span>{error}</span>
                <button
                  type="button"
                  className="font-medium text-foreground/80 hover:underline"
                  onClick={() => request(true)}
                  data-testid="swarm-run-insights-retry"
                >
                  Try again
                </button>
              </p>
            ) : (
              <RunSummary summary={insights!.summary} />
            )}
            {!busy && !error && !unavailable ? (
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => request(true)}
                data-testid="swarm-run-insights-regenerate"
              >
                Redo
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto">
        {filteredRows.length === 0 ? (
          <p
            className="px-3 py-2 text-[11px] text-muted-foreground"
            data-testid="swarm-run-insights-all-resolved"
          >
            No open problems
            {resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ""}
          </p>
        ) : (
          visible.map((row) => (
            <InsightRow
              key={row.fingerprint}
              row={row}
              onOpenSession={onOpenSession}
            />
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-1.5">
        <p className="truncate text-[11px] text-muted-foreground">
          {signals.sessionCount} sessions
          {caveats.length > 0 ? ` · ${caveats.join(" · ")}` : ""}
        </p>
        {filteredRows.length > VISIBLE_ROWS ? (
          <button
            type="button"
            className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowAll((prev) => !prev)}
            data-testid="swarm-run-insights-toggle"
          >
            {showAll ? "Show fewer" : `Show all ${filteredRows.length}`}
          </button>
        ) : null}
      </div>

      <DiscoverySection
        discovery={discovery ?? null}
        onOpenSession={onOpenSession}
      />
    </section>
  );
}

function RunSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsClamp = summary.length > SUMMARY_CLAMP_CHARS;
  return (
    <p
      className="min-w-0 flex-1 text-[11px] text-muted-foreground"
      data-testid="swarm-run-insights-summary"
    >
      <span className={cn(!expanded && needsClamp && "line-clamp-2")}>
        {summary}
      </span>
      {needsClamp ? (
        <button
          type="button"
          className="mt-0.5 block text-[11px] font-medium text-foreground/80 hover:underline"
          onClick={() => setExpanded((prev) => !prev)}
          data-testid="swarm-run-insights-summary-toggle"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </p>
  );
}

function InsightRow({
  row,
  onOpenSession,
}: {
  row: Row;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const dismissMut = useMutation(SWARM_MUTATIONS.dismissFinding as any);
  const undismissMut = useMutation(SWARM_MUTATIONS.undismissFinding as any);
  const [dismissedOptimistic, setDismissedOptimistic] = useState<
    boolean | null
  >(null);

  const { signal, insight, finding } = row;
  const dismissed =
    dismissedOptimistic ?? Boolean(finding && finding.dismissedAt !== null);
  const chip = finding ? STATUS_CHIP[finding.status] : undefined;
  const hasDetail = Boolean(
    insight?.rootCause ||
      insight?.recommendation ||
      signal.exemplarSessionIds.length ||
      signal.contrastSessionIds.length,
  );

  const toggleDismiss = () => {
    if (!finding) return;
    const next = !dismissed;
    setDismissedOptimistic(next);
    const mut = next ? dismissMut : undismissMut;
    mut({ findingId: finding.findingId } as any).catch(() => {
      setDismissedOptimistic(!next);
    });
  };

  return (
    <div
      className={cn("group px-3 py-1.5", dismissed && "opacity-50")}
      data-testid="swarm-run-insight"
      data-detector={signal.detector}
      data-dismissed={dismissed ? "true" : "false"}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => hasDetail && setExpanded((prev) => !prev)}
          data-testid="swarm-run-insight-headline"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              isBlockingShaped(signal.detector)
                ? "bg-red-500/70"
                : "bg-amber-500/60",
            )}
            aria-hidden="true"
          />
          <span className="truncate text-sm text-foreground">
            {signalSentence(signal)}
          </span>
          {hasDetail ? (
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden="true"
            />
          ) : null}
        </button>
        {chip ? (
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-0 text-[10px] font-medium",
              chip.className,
            )}
            data-testid="swarm-run-insight-status"
          >
            {chip.label}
            {finding && finding.occurrenceCount > 1
              ? ` ×${finding.occurrenceCount}`
              : ""}
          </span>
        ) : null}
        {finding ? (
          <button
            type="button"
            className={cn(
              "shrink-0 text-[11px] text-muted-foreground transition-opacity hover:text-foreground",
              // Hover/focus reveal keeps the row calm; Undo stays visible so
              // a dismissed finding is always recoverable.
              dismissed
                ? "opacity-100"
                : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            )}
            onClick={toggleDismiss}
            data-testid="swarm-run-insight-dismiss"
          >
            {dismissed ? "Undo" : "Dismiss"}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div
          className="mt-1 space-y-1 pl-3.5"
          data-testid="swarm-run-insight-detail"
        >
          {insight?.rootCause ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Why: </span>
              {insight.rootCause}
            </p>
          ) : null}
          {insight?.recommendation ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Fix: </span>
              {insight.recommendation}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {signal.exemplarSessionIds.map((sessionId, i) => (
              <SessionChip
                key={sessionId}
                label={`Session ${i + 1}`}
                onClick={() => onOpenSession(sessionId)}
              />
            ))}
            {signal.contrastSessionIds.map((sessionId, i) => (
              <SessionChip
                key={sessionId}
                label={`Clean ${i + 1}`}
                onClick={() => onOpenSession(sessionId)}
                subtle
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Lane B — what an open read of a session sample noticed that no metric
 * measures. Visually quieter than the rows above because it IS weaker
 * evidence, and must not borrow their authority.
 */
function DiscoverySection({
  discovery,
  onOpenSession,
}: {
  discovery: SwarmWaveDiscovery | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!discovery || discovery.findings.length === 0) return null;
  return (
    <div
      className="border-t border-border/40 px-3 py-1.5"
      data-testid="swarm-run-discovery"
    >
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="swarm-run-discovery-toggle"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        Also noticed ({discovery.findings.length}) — not measured by any check
      </button>
      {open ? (
        <div className="mt-1 space-y-1.5 pl-4">
          {discovery.findings.map((finding) => (
            <div
              key={finding.slug}
              data-testid="swarm-run-discovery-finding"
              data-kind={finding.kind}
            >
              <p className="text-xs text-foreground">{finding.title}</p>
              {finding.detail ? (
                <p className="text-[11px] text-muted-foreground">
                  {finding.detail}
                </p>
              ) : null}
              {finding.suggestedCheck ? (
                <SuggestedCheckChip
                  toolName={finding.suggestedCheck.toolName}
                />
              ) : null}
              {finding.sessionIds.length > 0 ? (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {finding.sessionIds.map((sessionId, i) => (
                    <SessionChip
                      key={sessionId}
                      label={`Session ${i + 1}`}
                      onClick={() => onOpenSession(sessionId)}
                      subtle
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A proposed rubric criterion, with its predicate spelled out and copyable.
 * Wiring it INTO a journey's rubric stays deferred: a run spans several
 * journeys, so "add this check" needs a multi-journey edit flow rather than a
 * button that silently picks one.
 */
function SuggestedCheckChip({ toolName }: { toolName: string }) {
  const [copied, setCopied] = useState(false);
  const predicate = `toolCalledAtLeastOnce(${toolName})`;
  return (
    <div className="mt-1 flex items-center gap-2">
      <span
        className="rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
        data-testid="swarm-run-discovery-check"
      >
        {predicate}
      </span>
      <button
        type="button"
        className="text-[11px] text-primary hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(predicate);
          setCopied(true);
        }}
        data-testid="swarm-run-discovery-check-copy"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function SessionChip({
  label,
  onClick,
  subtle = false,
}: {
  label: string;
  onClick: () => void;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted",
        subtle
          ? "border-border/50 text-muted-foreground"
          : "border-border text-foreground/80",
      )}
      data-testid="swarm-run-insight-session-link"
    >
      {label}
    </button>
  );
}
