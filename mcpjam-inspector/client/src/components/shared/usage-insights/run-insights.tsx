/**
 * Run insights — the answer, above the fold. One rail for Swarms and User
 * Testing.
 *
 * The two surfaces mine different populations but produce the SAME shape: a
 * deterministic signal, a registry finding that tracks it over time, and a
 * model explanation that enriches it. So the rail branches only on which
 * queries to read and how a detector phrases itself; everything about the
 * layout, the lifecycle, and the dismissal flow is shared.
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";

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
import {
  useRunInsights,
  type RunInsightsScope,
} from "@/hooks/use-run-insights";
import {
  CHATBOX_INSIGHTS_QUERIES,
  type ChatboxFinding,
  type ChatboxWindowSignals,
} from "@/lib/chatbox-insights-api";

/**
 * Which surface's rail this is. The chatbox arm carries no group id: the rail
 * DERIVES it from `getWindowSignals.latestGroupId`, so the narration it reads
 * always describes the window whose signals it is showing.
 */
export type RunInsightsSurface =
  | { kind: "swarm"; projectId: string; swarmRunGroupId: string }
  | { kind: "chatbox"; chatboxId: string };

/**
 * A signal, in the shape the rail renders. Structurally the swarm candidate
 * with the detector widened to a string: the two miners emit disjoint detector
 * unions over the same row shape, and the rail phrases both.
 */
export type RailSignalCandidate = Omit<
  SwarmWaveSignalCandidate,
  "detector" | "subjectKind"
> & {
  detector: string;
  subjectKind: string;
};

/** Registry row, in the shape the rail renders (the two DTOs differ in id key). */
type RailFinding = {
  findingId: string;
  fingerprint: string;
  status: "new" | "recurring" | "resolved" | "regressed";
  occurrenceCount: number;
  dismissedAt: number | null;
};

/** Live signals, in the shape the rail renders. */
type RailSignals = {
  candidates: RailSignalCandidate[];
  sessionCount: number;
  lowConfidence: boolean;
  truncated: boolean;
  /** Swarm only — a window has no judge. */
  judgeCoverage?: { graded: number; total: number };
  /** User Testing only — direct user voice in the window. */
  feedbackCount?: number;
  /** Ready to narrate: swarm runs must be terminal, windows must be frozen. */
  terminal: boolean;
  /** The frozen window this rail is showing (User Testing only). */
  latestGroupId?: string | null;
};

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
export function signalSentence(
  c: RailSignalCandidate,
  opts?: { cohort?: "run" | "window" },
): string {
  // Relative detectors compare a slice against everything else measured. On a
  // swarm that population is "the run"; on a hosted surface it is the window
  // of recent visits, and calling those "the run" would name something the
  // reader has no concept of.
  const rest = opts?.cohort === "window" ? "these sessions" : "the run";
  switch (c.detector) {
    case "tool_errors":
      return `${c.subjectLabel} failed ${c.metric ?? c.affectedSessions}× across ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "hallucinated_tool":
      // "Agents" is swarm vocabulary; a hosted visitor talked to one
      // assistant, and never called it an agent.
      return opts?.cohort === "window"
        ? `The assistant called a tool named "${c.subjectLabel}" that does not exist, in ${c.affectedSessions} ${plural(c.affectedSessions, "session")}`
        : `Agents invented a tool named "${c.subjectLabel}" in ${c.affectedSessions} ${plural(c.affectedSessions, "session")}`;
    // ── User Testing detectors ──
    case "negative_feedback":
      return `${c.affectedSessions} of ${c.sliceTotal} rated ${plural(c.sliceTotal, "session")} left negative feedback${c.subjectKind === "route" || c.subjectKind === "path" ? ` on ${c.subjectLabel}` : ""}`;
    case "cohort_struggles":
      return `${c.subjectLabel} visitors struggled in ${c.affectedSessions} of ${c.sliceTotal} sessions`;
    case "terminal_error_concentration":
      return `${c.affectedSessions} of ${c.sliceTotal} sessions ended on a tool error${c.subjectKind === "route" || c.subjectKind === "path" ? ` in ${c.subjectLabel}` : ""}`;
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
      return `"${c.subjectLabel}" uses ~${ratioLabel(c)} the tokens of the rest of ${rest}`;
    case "latency_outlier":
      return `${c.subjectLabel} p95 latency is ${ratioLabel(c)} the rest of ${rest}`;
    case "no_tools_used":
      return `${c.affectedSessions} ${plural(c.affectedSessions, "session")} in "${c.subjectLabel}" never called a tool`;
    default:
      return `${c.subjectLabel}: ${c.affectedSessions} of ${c.sliceTotal} sessions`;
  }
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function ratioLabel(c: RailSignalCandidate): string {
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
  signal: RailSignalCandidate;
  insight?: SwarmWaveInsightCandidate;
  finding?: RailFinding;
};

/**
 * The rail's data, resolved per surface.
 *
 * Both queries are guest-readable by design on User Testing, so this hook is
 * safe to mount for a viewer who cannot request generation — `canRequest`
 * below is what gates the spending act, separately from the reading one.
 */
function useRailData(surface: RunInsightsSurface): {
  signals: RailSignals | null | undefined;
  findings: RailFinding[] | undefined;
  cohort: "run" | "window";
} {
  const isSwarm = surface.kind === "swarm";

  const swarmSignals = useQuery(
    SWARM_QUERIES.getWaveSignals as any,
    (isSwarm
      ? {
          projectId: surface.projectId,
          swarmRunGroupId: surface.swarmRunGroupId,
        }
      : "skip") as any,
  ) as SwarmWaveSignals | null | undefined;
  const swarmFindings = useQuery(
    SWARM_QUERIES.listSwarmFindings as any,
    (isSwarm ? { projectId: surface.projectId } : "skip") as any,
  ) as SwarmFinding[] | undefined;

  const windowSignals = useQuery(
    CHATBOX_INSIGHTS_QUERIES.getWindowSignals as any,
    (isSwarm ? "skip" : { chatboxId: surface.chatboxId }) as any,
  ) as ChatboxWindowSignals | null | undefined;
  const windowFindings = useQuery(
    CHATBOX_INSIGHTS_QUERIES.listChatboxFindings as any,
    (isSwarm ? "skip" : { chatboxId: surface.chatboxId }) as any,
  ) as ChatboxFinding[] | undefined;

  if (isSwarm) {
    return {
      signals: swarmSignals
        ? {
            candidates: swarmSignals.candidates,
            sessionCount: swarmSignals.sessionCount,
            lowConfidence: swarmSignals.lowConfidence,
            truncated: swarmSignals.truncated,
            judgeCoverage: swarmSignals.judgeCoverage,
            terminal: swarmSignals.terminal,
          }
        : swarmSignals,
      findings: swarmFindings?.map((f) => ({
        findingId: f.findingId,
        fingerprint: f.fingerprint,
        status: f.status,
        occurrenceCount: f.occurrenceCount,
        dismissedAt: f.dismissedAt,
      })),
      cohort: "run",
    };
  }
  return {
    signals: windowSignals
      ? {
          candidates: windowSignals.candidates,
          sessionCount: windowSignals.sessionCount,
          lowConfidence: windowSignals.lowConfidence,
          truncated: windowSignals.truncated,
          feedbackCount: windowSignals.feedbackCount,
          // A window is narratable once an analysis has frozen one. Before
          // that there is no group id to attach narration to.
          terminal: windowSignals.latestGroupId !== null,
          latestGroupId: windowSignals.latestGroupId,
        }
      : windowSignals,
    findings: windowFindings?.map((f) => ({
      findingId: f._id,
      fingerprint: f.fingerprint,
      status: f.status,
      occurrenceCount: f.occurrenceCount,
      dismissedAt: f.dismissedAt,
    })),
    cohort: "window",
  };
}

/**
 * Which cohort's narration this surface reads. Null on User Testing until the
 * first snapshot exists — the group id names frozen data, and one may never be
 * guessed.
 */
function useNarrationScope(
  surface: RunInsightsSurface,
  latestGroupId: string | null | undefined,
): RunInsightsScope | null {
  return useMemo<RunInsightsScope | null>(() => {
    if (surface.kind === "swarm") {
      return {
        kind: "swarm",
        projectId: surface.projectId,
        swarmRunGroupId: surface.swarmRunGroupId,
      };
    }
    return latestGroupId
      ? { kind: "chatbox", chatboxId: surface.chatboxId, groupId: latestGroupId }
      : null;
  }, [surface, latestGroupId]);
}

export function RunInsights({
  surface,
  onOpenSession,
  canRequest = true,
  canDismiss = true,
  autoRequest = true,
}: {
  surface: RunInsightsSurface;
  onOpenSession: (sessionId: string) => void;
  /**
   * May this viewer SPEND? Generation is member-gated while viewing is not, so
   * a guest sees the signals and the findings and simply never auto-requests
   * narration — rather than watching a request fail.
   */
  canRequest?: boolean;
  /** May this viewer dismiss a finding? Same split: a judgment, not a view. */
  canDismiss?: boolean;
  /**
   * Off when an ancestor already drives the auto-request. `RunInsightsChip`
   * does, because this component lives inside a popover: Radix unmounts the
   * content on close, so a latch held here would forget on every open.
   */
  autoRequest?: boolean;
}) {
  const { signals, findings, cohort } = useRailData(surface);
  const terminal = signals?.terminal === true;
  // Nothing concentrated anywhere means there is nothing to explain, so a
  // clean cohort never spends a model call — "no anomalies" IS the answer.
  const hasSignals = (signals?.candidates.length ?? 0) > 0;

  const scope = useNarrationScope(surface, signals?.latestGroupId);

  const { insights, discovery, busy, unavailable, error, request } =
    useRunInsights(scope, {
      terminal,
      autoRequest: autoRequest && hasSignals && canRequest,
    });

  const [showAll, setShowAll] = useState(false);

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

  // Loading, unknown run, or a backend without the feature: render nothing
  // rather than a broken block.
  if (!signals) return null;
  if (!terminal) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="run-insights-pending-run"
      >
        {cohort === "window"
          ? "Insights appear once sessions settle."
          : "Insights appear when the run finishes."}
      </p>
    );
  }
  if (rows.length === 0 && !busy) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="run-insights-empty"
      >
        No anomalies detected across {signals.sessionCount} sessions.
      </p>
    );
  }

  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const caveats: string[] = [];
  if (
    signals.judgeCoverage &&
    signals.judgeCoverage.graded === 0 &&
    signals.judgeCoverage.total > 0
  ) {
    caveats.push("no judge verdicts — goal completion not assessed");
  }
  if (cohort === "window" && signals.feedbackCount === 0) {
    caveats.push("no feedback left yet");
  }
  if (signals.lowConfidence) caveats.push("most sessions still analyzing");
  if (signals.truncated) caveats.push("newest sessions only");
  if (insights && insights.unnarratedCandidates.length > 0) {
    caveats.push(`${insights.unnarratedCandidates.length} more not explained`);
  }

  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/20"
      data-testid="run-insights"
    >
      {(insights?.summary || busy) && (
        <div className="flex items-start gap-2 border-b border-border/40 px-3 py-2">
          {busy ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="run-insights-generating"
            >
              <Loader2 className="size-3.5 animate-spin" />
              Working out what went wrong…
            </p>
          ) : (
            <RunSummary summary={insights!.summary} />
          )}
          {!busy && !error && !unavailable && canRequest ? (
            <button
              type="button"
              className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => request(true)}
              data-testid="run-insights-regenerate"
            >
              Redo
            </button>
          ) : null}
        </div>
      )}

      <div className="divide-y divide-border/40">
        {visible.map((row) => (
          <InsightRow
            key={row.fingerprint}
            row={row}
            cohort={cohort}
            canDismiss={canDismiss}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1 px-3 py-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {signals.sessionCount} sessions
            {caveats.length > 0 ? ` · ${caveats.join(" · ")}` : ""}
          </p>
          {rows.length > VISIBLE_ROWS ? (
            <button
              type="button"
              className="shrink-0 text-[11px] font-medium text-primary hover:underline"
              onClick={() => setShowAll((prev) => !prev)}
              data-testid="run-insights-toggle"
            >
              {showAll ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          ) : null}
        </div>
        {error ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="run-insights-error"
          >
            {error}{" "}
            {canRequest ? (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => request(true)}
                data-testid="run-insights-retry"
              >
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      <DiscoverySection
        discovery={discovery ?? null}
        onOpenSession={onOpenSession}
      />
    </section>
  );
}

/** Compact statline chip for the signal/finding detail popover. */
export function RunInsightsChip({
  surface,
  onOpenSession,
  canRequest = true,
  canDismiss = true,
}: {
  surface: RunInsightsSurface;
  onOpenSession: (sessionId: string) => void;
  canRequest?: boolean;
  canDismiss?: boolean;
}) {
  // Signals FIRST. On User Testing the group id the narration is addressed by
  // comes out of this payload, so the chip cannot engage the insights hook
  // before it lands — and it must not guess one.
  const { signals, findings, cohort } = useRailData(surface);

  // THE LIFECYCLE LIVES HERE, not in the popover. `RunInsights` renders inside
  // `PopoverContent`, which Radix unmounts on close — taking the hook's
  // once-per-cohort and permission latches with it, so every reopen would
  // re-fire an auto-request a guest was already refused. The chip is mounted
  // for as long as the statline is, so driving it from here makes those
  // latches mean what they say. The inner instance subscribes to the same
  // query with the same args, which the Convex client dedupes.
  const scope = useNarrationScope(surface, signals?.latestGroupId);
  useRunInsights(scope, {
    terminal: signals?.terminal === true,
    autoRequest: (signals?.candidates.length ?? 0) > 0 && canRequest,
  });

  const activeCount = useMemo(() => {
    if (!signals || !findings) return 0;
    const findingByFingerprint = new Map(
      findings.map((finding) => [finding.fingerprint, finding]),
    );
    return signals.candidates.reduce((count, candidate) => {
      const finding = findingByFingerprint.get(signalFingerprint(candidate));
      return count + (finding && finding.status !== "resolved" ? 1 : 0);
    }, 0);
  }, [signals, findings]);

  if (!signals) return null;
  if (!signals.terminal) {
    return (
      <span
        className="inline-flex items-center rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs text-muted-foreground"
        data-testid="run-insights-chip"
      >
        {cohort === "window" ? "Insights appear once sessions settle" : "Analyzing…"}
      </span>
    );
  }

  const label =
    activeCount > 0
      ? `⚠ ${activeCount} pattern${activeCount === 1 ? "" : "s"}`
      : "No patterns";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
            activeCount > 0
              ? STATUS_CHIP.new.className
              : "border-border/50 bg-muted/25 text-muted-foreground hover:bg-muted/50",
          )}
          data-testid="run-insights-chip"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[65vh] w-[34rem] max-w-[90vw] overflow-y-auto p-0"
      >
        <RunInsights
          surface={surface}
          onOpenSession={onOpenSession}
          canRequest={canRequest}
          canDismiss={canDismiss}
          autoRequest={false}
        />
      </PopoverContent>
    </Popover>
  );
}

function RunSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsClamp = summary.length > SUMMARY_CLAMP_CHARS;
  return (
    <p
      className="min-w-0 flex-1 text-sm text-foreground"
      data-testid="run-insights-summary"
    >
      <span className={cn(!expanded && needsClamp && "line-clamp-2")}>
        {summary}
      </span>
      {needsClamp ? (
        <button
          type="button"
          className="mt-0.5 block text-[11px] font-medium text-primary hover:underline"
          onClick={() => setExpanded((prev) => !prev)}
          data-testid="run-insights-summary-toggle"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </p>
  );
}

function InsightRow({
  row,
  cohort,
  canDismiss,
  onOpenSession,
}: {
  row: Row;
  cohort: "run" | "window";
  canDismiss: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // ONE mutation for both surfaces. It is scope-branched server-side — the
  // finding row's own scope decides whether it authorizes by project role or
  // by the chatbox's workspace role — so the rail names it once, from where it
  // lives.
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
      className={cn("px-3 py-1.5", dismissed && "opacity-50")}
      data-testid="run-insight"
      data-detector={signal.detector}
      data-dismissed={dismissed ? "true" : "false"}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          onClick={() => hasDetail && setExpanded((prev) => !prev)}
          data-testid="run-insight-headline"
        >
          <span
            className={cn(
              "mt-[7px] size-1.5 shrink-0 rounded-full",
              isBlockingShaped(signal.detector)
                ? "bg-red-500/70"
                : "bg-amber-500/60",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 text-sm text-foreground">
            {signalSentence(signal, { cohort })}
          </span>
          {hasDetail ? (
            <ChevronRight
              className={cn(
                "mt-1 size-3 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden="true"
            />
          ) : null}
        </button>
        {chip ? (
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded border px-1 py-0 text-[10px] font-medium",
              chip.className,
            )}
            data-testid="run-insight-status"
          >
            {chip.label}
            {finding && finding.occurrenceCount > 1
              ? ` ×${finding.occurrenceCount}`
              : ""}
          </span>
        ) : null}
        {finding && canDismiss ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={toggleDismiss}
            data-testid="run-insight-dismiss"
          >
            {dismissed ? "Undo" : "Dismiss"}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div
          className="mt-1 space-y-1 pl-3.5"
          data-testid="run-insight-detail"
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
      data-testid="run-discovery"
    >
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="run-discovery-toggle"
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
              data-testid="run-discovery-finding"
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
        data-testid="run-discovery-check"
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
        data-testid="run-discovery-check-copy"
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
      data-testid="run-insight-session-link"
    >
      {label}
    </button>
  );
}
