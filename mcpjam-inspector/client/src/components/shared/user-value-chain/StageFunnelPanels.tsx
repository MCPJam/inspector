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

import { useQuery } from "convex/react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { StageFunnel } from "./StageFunnel";
import type { ChatSessionStageFunnel } from "./user-value-chain-types";

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
    (scenarioId ? { scenarioId } : "skip") as never
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
    { journeyRunId } as never
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

function SuiteRunStageFunnel({
  suiteRunId,
  className,
}: {
  suiteRunId: string | undefined;
  className?: string;
}) {
  const summary = useQuery(
    "chatSessionStageDerivation:getSuiteRunStageFunnel" as never,
    (suiteRunId ? { suiteRunId } : "skip") as never
  ) as ChatSessionStageFunnel | null | undefined;

  if (!summary) return null;

  return (
    <StageFunnel
      summary={summary}
      title="User value chain"
      populationLabel="Trials in this run"
      className={className}
    />
  );
}
