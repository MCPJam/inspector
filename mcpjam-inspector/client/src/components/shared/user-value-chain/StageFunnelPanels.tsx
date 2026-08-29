/**
 * The two funnel containers: one per surface, each with its own denominator.
 *
 * SEPARATE COMPONENTS, deliberately — mirroring the two separate backend
 * readers. A single container taking a discriminator would be one refactor
 * away from someone passing both populations, and there is no honest way to
 * add a User Testing scenario's sessions to a swarm run's: real people and a
 * persona rehearsal answer different questions, and neither is an eval trial.
 *
 * `useQuery` throws when the query is not deployed yet — and, in a test tree,
 * when there is no `ConvexProvider` at all. An `ErrorBoundary` only catches
 * what its DESCENDANTS throw, never what the component rendering it throws, so
 * each exported panel here is a THIN WRAPPER whose only job is to put the
 * boundary ABOVE the component that owns the query.
 *
 * That split, rather than a boundary at each mount site, is what makes the
 * guarantee the panel's own: a future caller cannot forget to wrap it, and the
 * dark-ship argument does not rest on every mount site remembering.
 */

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { StageFunnel } from "./StageFunnel";
import type {
  ChatSessionStageFunnel,
  StageTally,
} from "./user-value-chain-types";

/**
 * The User Testing funnel for one scenario.
 *
 * Its population is the scenario's REAL sessions — the backend excludes
 * synthetic ones, so a rehearsal cannot move a number that describes people.
 */
export function ScenarioStageFunnelPanel({
  scenarioId,
  className,
}: {
  scenarioId: string | undefined;
  className?: string;
}) {
  return (
    <ErrorBoundary fallback={null}>
      <ScenarioStageFunnel scenarioId={scenarioId} className={className} />
    </ErrorBoundary>
  );
}

function ScenarioStageFunnel({
  scenarioId,
  className,
}: {
  scenarioId: string | undefined;
  className?: string;
}) {
  const summary = useQuery(
    "chatSessionStageDerivation:getScenarioStageFunnel" as never,
    (scenarioId ? { scenarioId } : "skip") as never,
  ) as ChatSessionStageFunnel | null | undefined;

  // `undefined` is still loading and `null` is a scenario we cannot read.
  // Neither is "no sessions", which the funnel itself renders as notMeasured.
  if (!summary) return null;

  return (
    <StageFunnel
      summary={summary}
      title="User value chain"
      populationLabel="Real User Testing sessions"
      className={className}
    />
  );
}

/**
 * One funnel per swarm run.
 *
 * A swarm wave can carry several runs, and they are rendered SIDE BY SIDE
 * rather than folded together. Folding would be the same mistake at a smaller
 * scale: two runs against different hosts have different denominators, and a
 * combined bar would describe neither.
 */
export function SwarmRunStageFunnelPanels({
  journeyRunIds,
  className,
}: {
  journeyRunIds: ReadonlyArray<string>;
  className?: string;
}) {
  if (journeyRunIds.length === 0) return null;
  return (
    <ErrorBoundary fallback={null}>
      <div className={className}>
        {journeyRunIds.map((journeyRunId) => (
          <SwarmRunStageFunnelPanel
            key={journeyRunId}
            journeyRunId={journeyRunId}
          />
        ))}
      </div>
    </ErrorBoundary>
  );
}

function SwarmRunStageFunnelPanel({ journeyRunId }: { journeyRunId: string }) {
  const summary = useQuery(
    "chatSessionStageDerivation:getSwarmRunStageFunnel" as never,
    { journeyRunId } as never,
  ) as ChatSessionStageFunnel | null | undefined;

  if (!summary) return null;

  return (
    <StageFunnel
      summary={summary}
      title="User value chain"
      populationLabel="Sessions in this swarm run"
    />
  );
}

/**
 * The funnel for one eval suite run's trials.
 *
 * Its own denominator again, and the third population that must never be
 * folded into the other two: an eval trial is a pinned case executed against a
 * pinned config, which is neither a real person nor a persona rehearsal.
 *
 * COSTS NOTHING TO RENDER, which is why it is mounted unconditionally on the
 * run detail rather than behind an opt-in. The chain was already derived by
 * the stage worker; this reads the rollup. The explanatory flow diagram beside
 * it is a model's reading of the same traces, is bought per pass, and is
 * gated — the difference in how they are offered is the difference in what
 * they cost.
 */
export function SuiteRunStageFunnelPanel({
  suiteRunId,
  className,
}: {
  suiteRunId: string | undefined;
  className?: string;
}) {
  return (
    <ErrorBoundary fallback={null}>
      <SuiteRunStageFunnel suiteRunId={suiteRunId} className={className} />
    </ErrorBoundary>
  );
}

/**
 * Reports whether the suite-run funnel HAS anything to draw. Renders nothing.
 *
 * A container that decides whether to open at all cannot ask the panel — the
 * panel only exists once the container has opened. So the question is asked
 * here instead, by a probe mounted unconditionally and outside whatever the
 * answer gates.
 *
 * It re-runs the panel's own query rather than deriving an answer from
 * iteration rows: "the rollup exists" is the panel's actual render condition,
 * and any local approximation of it would be a second, drifting definition of
 * when the funnel appears. Convex de-duplicates identical subscriptions, so
 * asking twice costs one query.
 *
 * The `ErrorBoundary` is the same guarantee the panels above carry, for the
 * same reason: `useQuery` throws when the query is not deployed (dark ship) or
 * when there is no `ConvexProvider` (a test tree), and a probe that took a
 * whole run-detail page down with it would be worse than the empty rail it
 * exists to prevent. Undeployed reads as "no funnel", which is correct.
 */
export function SuiteRunStageFunnelAvailability({
  suiteRunId,
  onChange,
}: {
  suiteRunId: string | undefined;
  /**
   * Called with the run the answer is ABOUT, not just the answer. The caller
   * renders one run at a time from a component the run selector REUSES, so an
   * answer that does not name its run cannot be told apart from the previous
   * run's — and a stale `true` opens an empty rail on the run you switched to.
   */
  onChange: (suiteRunId: string | undefined, hasFunnel: boolean) => void;
}) {
  return (
    // KEYED by the run. An ErrorBoundary that has caught stays in its fallback
    // for the life of the element, so an unkeyed one would swallow the probe
    // for every LATER run too: one transient failure would hide the chain on
    // every run after it until the whole view remounted.
    <ErrorBoundary key={suiteRunId ?? "no-run"} fallback={null}>
      <SuiteRunStageFunnelProbe suiteRunId={suiteRunId} onChange={onChange} />
    </ErrorBoundary>
  );
}

function SuiteRunStageFunnelProbe({
  suiteRunId,
  onChange,
}: {
  suiteRunId: string | undefined;
  onChange: (suiteRunId: string | undefined, hasFunnel: boolean) => void;
}) {
  const funnel = useQuery(
    "evalStageRollups:getSuiteRunStageFunnel" as never,
    (suiteRunId ? { suiteRunId } : "skip") as never,
  ) as SuiteRunStageFunnel | null | undefined;

  // Exactly the panel's condition: `undefined` is still loading and `null` is
  // a run with no rollup. Neither draws anything, so neither should keep a
  // rail open.
  const hasFunnel = Boolean(funnel);
  useEffect(() => {
    onChange(suiteRunId, hasFunnel);
  }, [suiteRunId, hasFunnel, onChange]);

  return null;
}

function SuiteRunStageFunnel({
  suiteRunId,
  className,
}: {
  suiteRunId: string | undefined;
  className?: string;
}) {
  // `evalStageRollups`, NOT `chatSessionStageDerivation`. An eval trial carries
  // its chain on the iteration row, so no session-level derivation exists to
  // read — the rollup is the only place this funnel comes from.
  const funnel = useQuery(
    "evalStageRollups:getSuiteRunStageFunnel" as never,
    (suiteRunId ? { suiteRunId } : "skip") as never,
  ) as SuiteRunStageFunnel | null | undefined;

  if (!funnel) return null;

  return (
    <StageFunnel
      summary={toChatSessionFunnel(funnel)}
      title="User value chain"
      populationLabel="Trials in this run"
      className={className}
    />
  );
}

/** One eval run's funnel, as `evalStageRollups:getSuiteRunStageFunnel` returns it. */
type SuiteRunStageFunnel = {
  totalIterations: number;
  measuredIterations: number;
  stages: StageTally[];
  notMeasured: boolean;
};

/**
 * Rename fields. Derive nothing.
 *
 * The two vocabularies describe the same six stages over different
 * populations, so the stage rows cross unchanged — the backend already sends
 * `eligible`, `observations` and `passRate` derived by the same
 * `stageMeasuredRate` a scorecard is built from, precisely so this function
 * does no arithmetic. A rate computed here would be a second definition of it.
 *
 * TWO FIELDS ARE DELIBERATELY EMPTY, and both render as silence rather than as
 * a zero:
 *
 *   - `exclusions` is a closed record about DERIVATION lifecycle — `absent`,
 *     `deriving`, `stale`, `failed`. An eval run's exclusions are named
 *     iteration reasons (`setup_failed`, `evaluator_failure`, `no_verdict`).
 *     Mapping one onto the other would file a crashed evaluator as "the
 *     derivation worker gave up", which is exactly the mislabelling the
 *     evidence failure classes exist to prevent. The panel therefore says
 *     nothing about exclusions here; the run detail reports them in their own
 *     vocabulary.
 *   - `firstFailedStage` is a per-session tally the rollup does not carry. It
 *     records `failureCategories` instead, which is a different question.
 *
 * `StageFunnel` gates both sections on being non-empty, so an unmappable field
 * produces an absent section rather than a confident "0".
 */
function toChatSessionFunnel(
  funnel: SuiteRunStageFunnel,
): ChatSessionStageFunnel {
  return {
    // An eval trial is a pinned case against a pinned config: not a real
    // person, not a persona rehearsal, and not one of the three sources.
    source: null,
    total: funnel.totalIterations,
    counted: funnel.measuredIterations,
    exclusions: { absent: 0, deriving: 0, stale: 0, failed: 0 },
    stages: funnel.stages,
    firstFailedStage: {},
    notMeasured: funnel.notMeasured,
    truncated: false,
  };
}
