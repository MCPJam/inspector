/**
 * Wave Insights band — Lane A's output at the top of a wave's Insights tab.
 *
 * One summary sentence, then one row per signal whose CLAIM is visible and
 * whose cause / recommendation / evidence sit behind an expand (specifics
 * behind the disclosure; the tab should be scannable). Each row carries its
 * registry lifecycle — `new`, `recurring`, `regressed` — so a repeat offender
 * reads as a repeat offender rather than as fresh news.
 *
 * The band self-hides when the backend does not expose the feature, so an
 * older deployment simply shows the deterministic signals below it.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  SWARM_MUTATIONS,
  SWARM_QUERIES,
  type SwarmFinding,
  type SwarmWaveDiscovery,
  type SwarmWaveInsightCandidate,
} from "@/lib/swarm-api";
import { useSwarmWaveInsights } from "@/hooks/use-swarm-wave-insights";

/** Findings shown before "Show all". */
const VISIBLE_ROWS = 3;

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  new: {
    label: "New",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  recurring: {
    label: "Recurring",
    className: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  regressed: {
    label: "Regressed",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  resolved: {
    label: "Resolved",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
};

export function SwarmWaveInsightsBand({
  projectId,
  swarmRunGroupId,
  terminal,
  onOpenSession,
}: {
  projectId: string;
  swarmRunGroupId: string;
  /** Every run of the wave has finished — gates the auto-request. */
  terminal: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const { insights, discovery, status, busy, unavailable, error, request } =
    useSwarmWaveInsights(projectId, swarmRunGroupId, { terminal });
  const findings = useQuery(
    SWARM_QUERIES.listSwarmFindings as any,
    { projectId } as any,
  ) as SwarmFinding[] | undefined;
  const [showAll, setShowAll] = useState(false);

  const findingByFingerprint = useMemo(
    () => new Map((findings ?? []).map((f) => [f.fingerprint, f])),
    [findings],
  );

  if (unavailable) return null;
  if (!terminal) return null;

  const candidates = insights?.candidates ?? [];
  const visible = showAll ? candidates : candidates.slice(0, VISIBLE_ROWS);

  return (
    <div className="flex flex-col gap-2" data-testid="swarm-wave-insights-band">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Wave insights
        </p>
        {status === "completed" ? (
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
            onClick={() => request(true)}
            disabled={busy}
            data-testid="swarm-wave-insights-regenerate"
          >
            Regenerate
          </button>
        ) : null}
      </div>

      {busy ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="swarm-wave-insights-pending"
        >
          <Loader2 className="size-3.5 animate-spin" />
          Analyzing this swarm…
        </p>
      ) : null}

      {!busy && error ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="swarm-wave-insights-error"
        >
          <span>{error}</span>
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() => request(true)}
            data-testid="swarm-wave-insights-retry"
          >
            Try again
          </button>
        </div>
      ) : null}

      {!busy && insights ? (
        <>
          <p className="text-sm text-foreground" data-testid="swarm-wave-insights-summary">
            {insights.summary}
          </p>
          {insights.judgeCoverage.total > 0 &&
          insights.judgeCoverage.graded === 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="swarm-wave-insights-coverage"
            >
              No sessions in this swarm were graded by the judge, so goal
              completion is not part of this analysis.
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            {visible.map((candidate) => (
              <InsightRow
                key={candidate.fingerprint}
                candidate={candidate}
                finding={findingByFingerprint.get(candidate.fingerprint)}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
          {candidates.length > VISIBLE_ROWS ? (
            <button
              type="button"
              className="self-start text-xs font-medium text-primary hover:underline"
              onClick={() => setShowAll((prev) => !prev)}
              data-testid="swarm-wave-insights-toggle"
            >
              {showAll ? "Show fewer" : `Show all ${candidates.length} insights`}
            </button>
          ) : null}
          {insights.unnarratedCandidates.length > 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="swarm-wave-insights-unnarrated"
            >
              {insights.unnarratedCandidates.length} more signal
              {insights.unnarratedCandidates.length === 1 ? "" : "s"} were
              detected but not analyzed in detail.
            </p>
          ) : null}
          <DiscoverySection
            discovery={discovery ?? null}
            onOpenSession={onOpenSession}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Lane B — things a read of a session sample noticed that no metric measures.
 *
 * Visually separated from the Lane A rows on purpose: these are weaker
 * evidence (model-noticed, sampled) and must not borrow the authority of a
 * deterministically detected signal. Absent entirely against a backend that
 * predates the lane.
 */
function DiscoverySection({
  discovery,
  onOpenSession,
}: {
  discovery: SwarmWaveDiscovery | null;
  onOpenSession: (sessionId: string) => void;
}) {
  if (!discovery || discovery.findings.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-col gap-2 border-t border-border/40 pt-3"
      data-testid="swarm-wave-discovery"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Also noticed
      </p>
      <p className="text-[11px] text-muted-foreground">
        From reading {discovery.sampledSessionIds.length} sampled session
        {discovery.sampledSessionIds.length === 1 ? "" : "s"} — not measured by
        any check.
      </p>
      {discovery.findings.map((finding) => (
        <div
          key={finding.slug}
          className="rounded-md border border-border/40 bg-muted/20 px-3 py-2"
          data-testid="swarm-wave-discovery-finding"
          data-kind={finding.kind}
        >
          <p className="text-sm text-foreground">{finding.title}</p>
          {finding.detail ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {finding.detail}
            </p>
          ) : null}
          {finding.suggestedCheck ? (
            <SuggestedCheckChip toolName={finding.suggestedCheck.toolName} />
          ) : null}
          {finding.sessionIds.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
  );
}

/**
 * A proposed rubric criterion, rendered with its predicate spelled out and
 * copyable. Wiring it INTO a journey's rubric is deliberately deferred: a wave
 * spans several journeys, so "add this check" needs a multi-journey edit flow
 * rather than a button that silently picks one.
 */
function SuggestedCheckChip({ toolName }: { toolName: string }) {
  const [copied, setCopied] = useState(false);
  const predicate = `toolCalledAtLeastOnce(${toolName})`;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span
        className="rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
        data-testid="swarm-wave-discovery-check"
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
        data-testid="swarm-wave-discovery-check-copy"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function InsightRow({
  candidate,
  finding,
  onOpenSession,
}: {
  candidate: SwarmWaveInsightCandidate;
  finding: SwarmFinding | undefined;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const dismissMut = useMutation(SWARM_MUTATIONS.dismissFinding as any);
  const undismissMut = useMutation(SWARM_MUTATIONS.undismissFinding as any);
  const [dismissedOptimistic, setDismissedOptimistic] = useState<boolean | null>(
    null,
  );

  const dismissed =
    dismissedOptimistic ?? Boolean(finding && finding.dismissedAt !== null);
  const chip = finding ? STATUS_CHIP[finding.status] : undefined;

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
      className={cn(
        "rounded-md border px-3 py-2",
        dismissed
          ? "border-border/40 bg-muted/20 opacity-60"
          : "border-border/60 bg-muted/30",
      )}
      data-testid="swarm-wave-insight"
      data-fingerprint={candidate.fingerprint}
      data-dismissed={dismissed ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex-1 text-left"
          onClick={() => setExpanded((prev) => !prev)}
          data-testid="swarm-wave-insight-claim"
        >
          <span className="text-sm text-foreground">{candidate.claim}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {chip ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px] font-medium",
                chip.className,
              )}
              data-testid="swarm-wave-insight-status"
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
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={toggleDismiss}
              data-testid="swarm-wave-insight-dismiss"
            >
              {dismissed ? "Undo" : "Dismiss"}
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-2 flex flex-col gap-1.5" data-testid="swarm-wave-insight-detail">
          {candidate.rootCause ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Likely cause: </span>
              {candidate.rootCause}
            </p>
          ) : null}
          {candidate.recommendation ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Try: </span>
              {candidate.recommendation}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {candidate.evidenceSessionIds.map((sessionId, i) => (
              <SessionChip
                key={sessionId}
                label={`Evidence ${i + 1}`}
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
          <p className="text-[11px] text-muted-foreground">
            {candidate.affectedSessions} of {candidate.sliceTotal} sessions ·{" "}
            {candidate.confidence} confidence
            {candidate.evidenceTruncated ? " · evidence truncated" : ""}
          </p>
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
          : "border-border text-foreground/80",
      )}
      data-testid="swarm-wave-insight-session-link"
    >
      {label}
    </button>
  );
}
