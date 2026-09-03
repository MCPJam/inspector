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
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
  type UseRunInsightsResult,
} from "@/hooks/use-run-insights";
import {
  SCENARIO_INSIGHTS_QUERIES,
  type ScenarioFinding,
  type ScenarioWindowSignals,
} from "@/lib/scenario-insights-api";
import { InsightBannerShell } from "@/components/evals/insight-banner-shell";

/**
 * Which surface's rail this is. The scenario arm carries no group id: the rail
 * DERIVES it from `getWindowSignals.latestGroupId`, so the narration it reads
 * always describes the window whose signals it is showing.
 */
export type RunInsightsSurface =
  | { kind: "swarm"; projectId: string; swarmRunGroupId: string }
  | { kind: "scenario"; scenarioId: string };

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
  /** The feedback scan hit its cap: `feedbackCount` is a floor, not a total. */
  feedbackTruncated?: boolean;
  /** Ready to narrate: swarm runs must be terminal, windows must be frozen. */
  terminal: boolean;
  /** The frozen window this rail is showing (User Testing only). */
  latestGroupId?: string | null;
  /**
   * May this viewer act, per the SERVER — computed there from the same
   * predicate the mutations enforce (User Testing only).
   *
   * The affordance and the gate must not be answered by two different
   * authorities, so where the server offers the answer it wins over the
   * caller's prop. Swarm has no such field yet and keeps the prop.
   */
  canRequest?: boolean;
  canDismiss?: boolean;
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
      // UNITS ARE SESSIONS. The detector used to have a second fire path off
      // launch attempts, where this pair counted attempts and the bare
      // "(1 of 2)" read as sessions. That path is gone (launch outcomes are
      // reported as target health, never mined), so the noun is stated.
      return `Tool errors concentrate on ${c.subjectLabel} in ${c.affectedSessions} of ${c.sliceTotal} ${plural(c.sliceTotal, "session")}`;
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

/**
 * A row may open into Why/Fix ONLY when it names a session that exhibits the
 * anomaly.
 *
 * Cause and recommendation are the model's words. Behind an expander with no
 * failing session to open, they are an unfalsifiable claim: the reader cannot
 * check them, and the row's authority comes entirely from the confident prose.
 * A contrast ("Clean 1") does not count — it proves the anomaly did NOT happen
 * somewhere, which points at nothing to look at.
 *
 * The backend now enforces the same rule at both ends (`isGroundedCandidate`
 * in the miners, `partitionByLoadedEvidence` before narration). This is the
 * client's own check, not a mirror of theirs: an older server, a cached
 * payload, or a future detector can still hand this component a row without
 * exemplars, and it must degrade to the deterministic sentence rather than
 * offer prose it cannot back.
 */
function canExpand(
  signal: Pick<RailSignalCandidate, "exemplarSessionIds">,
): boolean {
  return signal.exemplarSessionIds.length > 0;
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
    SCENARIO_INSIGHTS_QUERIES.getWindowSignals as any,
    (isSwarm ? "skip" : { scenarioId: surface.scenarioId }) as any,
  ) as ScenarioWindowSignals | null | undefined;
  const windowFindings = useQuery(
    SCENARIO_INSIGHTS_QUERIES.listScenarioFindings as any,
    (isSwarm ? "skip" : { scenarioId: surface.scenarioId }) as any,
  ) as ScenarioFinding[] | undefined;

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
          feedbackTruncated: windowSignals.feedbackTruncated,
          // A window is narratable once an analysis has frozen one. Before
          // that there is no group id to attach narration to.
          terminal: windowSignals.latestGroupId !== null,
          latestGroupId: windowSignals.latestGroupId,
          canRequest: windowSignals.canRequest,
          canDismiss: windowSignals.canDismiss,
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
      ? { kind: "scenario", scenarioId: surface.scenarioId, groupId: latestGroupId }
      : null;
  }, [surface, latestGroupId]);
}

/**
 * The rail itself: signals joined to narration and to registry findings.
 *
 * PURELY DRIVEN. Entry points own the data and the lifecycle and hand them
 * in, so the same rail can render standalone, under the top banner, or inside
 * the legacy chip popover without a second subscription — and, more
 * importantly, without a second COPY of the lifecycle. An auto-request
 * rejected before any row exists (a daily limit, a guest refusal) leaves its
 * error on the hook that fired it; a body with its own hook would show neither
 * the message nor the retry, and the failure would be silent.
 */
function RunInsightsBody({
  rail,
  lifecycle,
  onOpenSession,
  canRequest,
  canDismiss,
  hideSummary = false,
  presentation = "card",
}: {
  rail: ReturnType<typeof useRailData>;
  lifecycle: UseRunInsightsResult;
  onOpenSession: (sessionId: string) => void;
  canRequest: boolean;
  canDismiss: boolean;
  /** When the summary already lives in {@link RunInsightsBanner}. */
  hideSummary?: boolean;
  /** `embedded` drops the outer card chrome for nesting under the banner. */
  presentation?: "card" | "embedded";
}) {
  const { signals, findings, cohort } = rail;
  const terminal = signals?.terminal === true;
  const { insights, discovery, busy, unavailable, error, request } = lifecycle;

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
  // A capped rating scan makes `feedbackCount` a floor, and every feedback
  // number beside it partial. Read from the narration too, because that one
  // describes the FROZEN window the explanations are about, which can differ
  // from the live one this rail is otherwise showing.
  if (
    signals.feedbackTruncated ||
    (insights && "feedbackTruncated" in insights && insights.feedbackTruncated)
  ) {
    caveats.push("some ratings unread");
  }
  if (signals.lowConfidence) caveats.push("most sessions still analyzing");
  if (signals.truncated) caveats.push("newest sessions only");
  if (insights && insights.unnarratedCandidates.length > 0) {
    caveats.push(`${insights.unnarratedCandidates.length} more not explained`);
  }

  const body = (
    <>
      {!hideSummary && (insights?.summary || busy) ? (
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
      ) : null}

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
    </>
  );

  if (presentation === "embedded") {
    return <div data-testid="run-insights">{body}</div>;
  }

  return (
    <section
      className="rounded-lg border border-border/60 bg-muted/20"
      data-testid="run-insights"
    >
      {body}
    </section>
  );
}

/**
 * Read the rail's data and drive its narration lifecycle. Shared by both entry
 * points so a signal and the narration beside it can never describe different
 * cohorts — on User Testing the group id comes out of the signals payload, and
 * a second reader could latch a different one.
 */
function useRail(
  surface: RunInsightsSurface,
  canRequestProp: boolean,
  canDismissProp: boolean,
): {
  rail: ReturnType<typeof useRailData>;
  lifecycle: UseRunInsightsResult;
  canRequest: boolean;
  canDismiss: boolean;
} {
  const rail = useRailData(surface);
  // The SERVER's answer wins wherever it offers one: it is computed from the
  // same predicate the mutations enforce, so the affordance cannot drift from
  // the gate — nor disappear because some id the mutation never consults
  // happens to be absent. The prop remains the answer for swarm, which has no
  // such field, and the fallback while the query is in flight.
  const canRequest = rail.signals?.canRequest ?? canRequestProp;
  const canDismiss = rail.signals?.canDismiss ?? canDismissProp;
  const scope = useNarrationScope(surface, rail.signals?.latestGroupId);
  const lifecycle = useRunInsights(scope, {
    terminal: rail.signals?.terminal === true,
    // Nothing concentrated anywhere means there is nothing to explain, so a
    // clean cohort never spends a model call — "no anomalies" IS the answer.
    autoRequest: (rail.signals?.candidates.length ?? 0) > 0 && canRequest,
  });
  return { rail, lifecycle, canRequest, canDismiss };
}

type RunInsightsRailContextValue = ReturnType<typeof useRail> & {
  onOpenSession: (sessionId: string) => void;
};

const RunInsightsRailContext =
  createContext<RunInsightsRailContextValue | null>(null);

function useRunInsightsRail(): RunInsightsRailContextValue {
  const ctx = useContext(RunInsightsRailContext);
  if (!ctx) {
    throw new Error(
      "RunInsightsBanner / RunInsightsRecommendations require RunInsightsProvider",
    );
  }
  return ctx;
}

/**
 * Owns the signals + narration lifecycle once for the Insights page so the
 * summary banner and Recommendations section never fork a second auto-request.
 */
export function RunInsightsProvider({
  surface,
  onOpenSession,
  canRequest = true,
  canDismiss = true,
  children,
}: {
  surface: RunInsightsSurface;
  onOpenSession: (sessionId: string) => void;
  canRequest?: boolean;
  canDismiss?: boolean;
  children: ReactNode;
}) {
  const railState = useRail(surface, canRequest, canDismiss);
  return (
    <RunInsightsRailContext.Provider
      value={{ ...railState, onOpenSession }}
    >
      {children}
    </RunInsightsRailContext.Provider>
  );
}

function buildInsightRows(
  rail: ReturnType<typeof useRailData>,
  lifecycle: UseRunInsightsResult,
): Row[] {
  const { signals, findings } = rail;
  const { insights } = lifecycle;
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
}

/** The rail, standalone. */
export function RunInsights({
  surface,
  onOpenSession,
  canRequest = true,
  canDismiss = true,
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
}) {
  const {
    rail,
    lifecycle,
    canRequest: mayRequest,
    canDismiss: mayDismiss,
  } = useRail(surface, canRequest, canDismiss);
  return (
    <RunInsightsBody
      rail={rail}
      lifecycle={lifecycle}
      onOpenSession={onOpenSession}
      canRequest={mayRequest}
      canDismiss={mayDismiss}
    />
  );
}

function countActivePatterns(
  signals: RailSignals | null | undefined,
  findings: RailFinding[] | undefined,
): number {
  if (!signals || !findings) return 0;
  const findingByFingerprint = new Map(
    findings.map((finding) => [finding.fingerprint, finding]),
  );
  return signals.candidates.reduce((count, candidate) => {
    const finding = findingByFingerprint.get(signalFingerprint(candidate));
    return count + (finding && finding.status !== "resolved" ? 1 : 0);
  }, 0);
}

/**
 * Top-level Run insights summary — same {@link InsightBannerShell} chrome as
 * the suite dashboard. Pattern findings live in
 * {@link RunInsightsRecommendations} in the Findings rail.
 */
export function RunInsightsBanner() {
  const {
    rail,
    lifecycle,
    canRequest: mayRequest,
  } = useRunInsightsRail();
  const { signals, findings, cohort } = rail;
  const { insights, busy, unavailable, error, request } = lifecycle;

  const activeCount = useMemo(
    () => countActivePatterns(signals, findings),
    [signals, findings],
  );

  if (!signals) return null;

  const summary = insights?.summary ?? null;

  let body: ReactNode;
  if (!signals.terminal) {
    body = (
      <p
        className="min-w-0 flex-1 text-sm text-muted-foreground"
        data-testid="run-insights-pending-run"
      >
        {cohort === "window"
          ? "Insights appear once sessions settle."
          : "Insights appear when the run finishes."}
      </p>
    );
  } else if (busy && !summary) {
    body = (
      <p
        className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
        data-testid="run-insights-generating"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        Working out what went wrong…
      </p>
    );
  } else if (summary) {
    body = <RunSummary summary={summary} />;
  } else if (activeCount === 0) {
    body = (
      <p
        className="min-w-0 flex-1 text-sm text-muted-foreground"
        data-testid="run-insights-empty"
      >
        No anomalies detected across {signals.sessionCount} sessions.
      </p>
    );
  } else {
    body = (
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {activeCount} pattern{activeCount === 1 ? "" : "s"} detected
        {busy ? " — working out what went wrong…" : "."}
      </p>
    );
  }

  return (
    <InsightBannerShell
      label="Run insights"
      testId="run-insights-banner"
      trailing={
        !busy && summary && !error && !unavailable && mayRequest ? (
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => request(true)}
            data-testid="run-insights-regenerate"
          >
            Redo
          </button>
        ) : undefined
      }
    >
      <div className="min-w-0 flex-1">{body}</div>
    </InsightBannerShell>
  );
}

/**
 * Recommendations: pattern findings as expandable rows. Card chrome lives on
 * Findings; this is a subsection, not a second card.
 */
export function RunInsightsRecommendations() {
  const {
    rail,
    lifecycle,
    canRequest,
    canDismiss: mayDismiss,
    onOpenSession,
  } = useRunInsightsRail();
  const { signals, cohort } = rail;
  const { insights, busy, error, request } = lifecycle;

  const rows = useMemo(
    () => buildInsightRows(rail, lifecycle),
    [rail, lifecycle],
  );
  const [showAll, setShowAll] = useState(false);

  if (!signals || !signals.terminal) return null;
  if (rows.length === 0 && !busy && !error) return null;

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
  if (
    signals.feedbackTruncated ||
    (insights && "feedbackTruncated" in insights && insights.feedbackTruncated)
  ) {
    caveats.push("some ratings unread");
  }
  if (signals.lowConfidence) caveats.push("most sessions still analyzing");
  if (signals.truncated) caveats.push("newest sessions only");

  return (
    <div data-testid="run-insights-recommendations">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2.5 pb-2">
        <h3 className="text-sm font-semibold tracking-tight">Recommendations</h3>
        <span className="text-xs text-muted-foreground">
          Patterns to investigate across sessions
        </span>
      </div>
      <div>
        {busy && rows.length === 0 ? (
          <p
            className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground"
            data-testid="run-insights-generating"
          >
            <Loader2 className="size-3.5 animate-spin" />
            Working out what went wrong…
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div className="divide-y divide-border/50">
            {visible.map((row) => (
              <RecommendationRow
                key={row.fingerprint}
                row={row}
                cohort={cohort}
                canDismiss={mayDismiss}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-1 border-t bg-muted/30 px-3 py-1.5">
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
      </div>
    </div>
  );
}

/** Expandable pattern row. */
function RecommendationRow({
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
  const dismissMut = useMutation(SWARM_MUTATIONS.dismissFinding as any);
  const undismissMut = useMutation(SWARM_MUTATIONS.undismissFinding as any);
  const [dismissedOptimistic, setDismissedOptimistic] = useState<
    boolean | null
  >(null);

  const { signal, insight, finding } = row;
  const dismissed =
    dismissedOptimistic ?? Boolean(finding && finding.dismissedAt !== null);
  const chip = finding ? STATUS_CHIP[finding.status] : undefined;
  const affected = signal.affectedSessions;
  const headline = signalSentence(signal, { cohort });
  // Gated on a failing exemplar and nothing else — see `canExpand`. An
  // exemplar alone is worth opening for (the session chips are the point);
  // prose without one is not.
  const hasDetail = canExpand(signal);
  // Evidence can disappear under an OPEN row: signals are a live subscription,
  // and a refresh that drops the exemplars would otherwise leave the model's
  // prose on screen with nothing behind it. Derived, not stored, so the row
  // closes the moment it stops qualifying.
  const isExpanded = hasDetail && expanded;

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
      className={cn(dismissed && "opacity-50")}
      data-testid="run-insight"
      data-detector={signal.detector}
      data-dismissed={dismissed ? "true" : "false"}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((prev) => !prev)}
          disabled={!hasDetail}
          aria-expanded={hasDetail ? isExpanded : undefined}
          aria-label={headline}
          className={cn(
            "flex h-6 min-w-7 shrink-0 items-center justify-center rounded border px-1 font-mono text-xs font-semibold tabular-nums transition-colors",
            "disabled:cursor-default",
            isBlockingShaped(signal.detector)
              ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20",
          )}
          data-testid="run-insight-count"
        >
          {affected}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => hasDetail && setExpanded((prev) => !prev)}
          aria-expanded={hasDetail ? isExpanded : undefined}
          data-testid="run-insight-headline"
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={headline}>
            {headline}
          </span>
          {hasDetail ? (
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
              aria-hidden="true"
            />
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {chip ? (
            <span
              className={cn(
                "rounded border px-1 py-0 text-[10px] font-medium",
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
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={toggleDismiss}
              data-testid="run-insight-dismiss"
            >
              {dismissed ? "Undo" : "Dismiss"}
            </button>
          ) : null}
        </div>
      </div>
      {isExpanded ? (
        <div
          className="space-y-1 border-t border-border/40 bg-muted/20 px-3 py-2 pl-12"
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
            {/* Contrast chips ride ALONGSIDE failing ones, never alone. A
                lone "Clean 1" reads as evidence for a claim while pointing at
                a session where the problem did not happen. */}
            {signal.exemplarSessionIds.length > 0
              ? signal.contrastSessionIds.map((sessionId, i) => (
                  <SessionChip
                    key={sessionId}
                    label={`Clean ${i + 1}`}
                    onClick={() => onOpenSession(sessionId)}
                    subtle
                  />
                ))
              : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated Prefer {@link RunInsightsBanner}. Kept for focused lifecycle tests. */
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
  // THE LIFECYCLE LIVES HERE, not in the popover. Radix unmounts
  // `PopoverContent` on close, and a hook mounted in there would lose its
  // once-per-cohort and permission latches every time — re-firing on reopen a
  // request a guest was already refused. The chip is mounted as long as the
  // parent is, and it HANDS the lifecycle to the body rather than letting it
  // start a second one.
  const {
    rail,
    lifecycle,
    canRequest: mayRequest,
    canDismiss: mayDismiss,
  } = useRail(surface, canRequest, canDismiss);
  const { signals, findings, cohort } = rail;

  const activeCount = useMemo(
    () => countActivePatterns(signals, findings),
    [signals, findings],
  );

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
        <RunInsightsBody
          rail={rail}
          lifecycle={lifecycle}
          onOpenSession={onOpenSession}
          canRequest={mayRequest}
          canDismiss={mayDismiss}
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
  // by the scenario's workspace role — so the rail names it once, from where it
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
  // Gated on a failing exemplar and nothing else — see `canExpand`. An
  // exemplar alone is worth opening for (the session chips are the point);
  // prose without one is not.
  const hasDetail = canExpand(signal);
  // Evidence can disappear under an OPEN row: signals are a live subscription,
  // and a refresh that drops the exemplars would otherwise leave the model's
  // prose on screen with nothing behind it. Derived, not stored, so the row
  // closes the moment it stops qualifying.
  const isExpanded = hasDetail && expanded;

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
          aria-expanded={hasDetail ? isExpanded : undefined}
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
                isExpanded && "rotate-90",
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

      {isExpanded ? (
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
            {/* Contrast chips ride ALONGSIDE failing ones, never alone. A
                lone "Clean 1" reads as evidence for a claim while pointing at
                a session where the problem did not happen. */}
            {signal.exemplarSessionIds.length > 0
              ? signal.contrastSessionIds.map((sessionId, i) => (
                  <SessionChip
                    key={sessionId}
                    label={`Clean ${i + 1}`}
                    onClick={() => onOpenSession(sessionId)}
                    subtle
                  />
                ))
              : null}
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
