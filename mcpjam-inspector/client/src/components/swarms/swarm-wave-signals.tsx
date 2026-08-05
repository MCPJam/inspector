/**
 * Wave Signals — the deterministic lane of Swarm Wave Insights.
 *
 * Renders the anomaly candidates `swarmWaveInsights:getWaveSignals` mined for
 * ONE wave: where trouble concentrates (a tool, a criterion, an environment, a
 * persona, a journey), with exemplar sessions one click away. Everything shown
 * is backend-computed; this component only phrases counts — no scoring, no
 * inference, and no LLM anywhere in this lane.
 *
 * Renders nothing for legacy waves (no durable `swarmRunGroupId` — the parent
 * gates on that) and self-hides while the query loads or when the backend
 * predates the feature, so the Insights tab never breaks on version skew.
 */
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import {
  SWARM_QUERIES,
  type SwarmWaveSignalCandidate,
  type SwarmWaveSignals,
} from "@/lib/swarm-api";

/** Candidates visible before "Show all" — specifics stay behind the expand. */
const VISIBLE_CANDIDATES = 3;

/**
 * One deterministic sentence per detector. Counts come from the candidate
 * verbatim — phrasing is the ONLY thing this layer adds.
 */
export function waveSignalSentence(c: SwarmWaveSignalCandidate): string {
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
      return `"${c.subjectLabel}" uses ~${ratioLabel(c)} the tokens of the rest of the wave`;
    case "latency_outlier":
      return `${c.subjectLabel} p95 latency is ${ratioLabel(c)} the rest of the wave`;
    case "no_tools_used":
      return `${c.affectedSessions} ${plural(c.affectedSessions, "session")} in "${c.subjectLabel}" never called a tool`;
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

/** The hallucination detector is the one "missing capability" signal — worth a
 * visually distinct row even inside a minimal list. */
function isBlockingShaped(c: SwarmWaveSignalCandidate): boolean {
  return c.detector === "hallucinated_tool" || c.detector === "criterion_fail";
}

export function SwarmWaveSignalsList({
  projectId,
  swarmRunGroupId,
  onOpenSession,
}: {
  projectId: string;
  /** Durable wave id — the parent renders this component only when present. */
  swarmRunGroupId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const signals = useQuery(
    SWARM_QUERIES.getWaveSignals as any,
    { projectId, swarmRunGroupId } as any
  ) as SwarmWaveSignals | null | undefined;
  const [showAll, setShowAll] = useState(false);

  const candidates = useMemo(
    () => signals?.candidates ?? [],
    [signals]
  );

  // Loading, unknown wave, or a backend that predates the feature (the query
  // lookup fails and convex returns undefined forever): show nothing rather
  // than a broken section.
  if (signals === undefined || signals === null) return null;

  if (!signals.terminal) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="swarm-wave-signals-pending"
      >
        Signals appear when the wave finishes.
      </p>
    );
  }

  const visible = showAll ? candidates : candidates.slice(0, VISIBLE_CANDIDATES);

  return (
    <div className="flex flex-col gap-2" data-testid="swarm-wave-signals">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Signals
      </p>
      {signals.lowConfidence ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="swarm-wave-signals-low-confidence"
        >
          Most sessions are still being analyzed — counts are partial.
        </p>
      ) : null}
      {signals.truncated ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="swarm-wave-signals-truncated"
        >
          This wave is larger than the scan window; counts cover the newest
          sessions only.
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="swarm-wave-signals-empty"
        >
          No anomalies detected in this wave.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {visible.map((candidate) => (
              <SignalRow
                key={`${candidate.detector}:${candidate.subjectKind}:${candidate.subjectId}`}
                candidate={candidate}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
          {candidates.length > VISIBLE_CANDIDATES ? (
            <button
              type="button"
              className="self-start text-xs font-medium text-primary hover:underline"
              onClick={() => setShowAll((prev) => !prev)}
              data-testid="swarm-wave-signals-toggle"
            >
              {showAll
                ? "Show fewer"
                : `Show all ${candidates.length} signals`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function SignalRow({
  candidate,
  onOpenSession,
}: {
  candidate: SwarmWaveSignalCandidate;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSessions =
    candidate.exemplarSessionIds.length > 0 ||
    candidate.contrastSessionIds.length > 0;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        isBlockingShaped(candidate)
          ? "border-red-500/25 bg-red-500/[0.06]"
          : "border-border/50 bg-muted/30"
      )}
      data-testid="swarm-wave-signal"
      data-detector={candidate.detector}
      data-subject-id={candidate.subjectId}
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => hasSessions && setExpanded((prev) => !prev)}
        data-testid="swarm-wave-signal-row"
      >
        <span className="text-sm text-foreground">
          {waveSignalSentence(candidate)}
        </span>
        {hasSessions ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {expanded ? "Hide" : "Sessions"}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="swarm-wave-signal-sessions"
        >
          {candidate.exemplarSessionIds.map((sessionId, i) => (
            <SessionChip
              key={sessionId}
              label={`Session ${i + 1}`}
              onClick={() => onOpenSession(sessionId)}
            />
          ))}
          {candidate.contrastSessionIds.map((sessionId, i) => (
            <SessionChip
              key={sessionId}
              label={`Clean ${i + 1}`}
              onClick={() => onOpenSession(sessionId)}
              subtle
            />
          ))}
        </div>
      ) : null}
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
          : "border-border text-foreground/80"
      )}
      data-testid="swarm-wave-signal-session-link"
    >
      {label}
    </button>
  );
}
