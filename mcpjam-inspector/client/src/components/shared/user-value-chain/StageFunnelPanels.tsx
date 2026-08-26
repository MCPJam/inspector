/**
 * The two funnel containers: one per surface, each with its own denominator.
 *
 * SEPARATE COMPONENTS, deliberately — mirroring the two separate backend
 * readers. A single container taking a discriminator would be one refactor
 * away from someone passing both populations, and there is no honest way to
 * add a User Testing scenario's sessions to a swarm run's: real people and a
 * persona rehearsal answer different questions, and neither is an eval trial.
 *
 * `ErrorBoundary` at every mount, matching the metric strips beside them:
 * `useQuery` against a query this deployment has not deployed yet THROWS, and
 * these ship ahead of the backend that answers them.
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
  const summary = useQuery(
    "chatSessionStageDerivation:getScenarioStageFunnel" as never,
    (scenarioId ? { scenarioId } : "skip") as never
  ) as ChatSessionStageFunnel | null | undefined;

  // `undefined` is still loading and `null` is a scenario we cannot read.
  // Neither is "no sessions", which the funnel itself renders as notMeasured.
  if (!summary) return null;

  return (
    <ErrorBoundary fallback={null}>
      <StageFunnel
        summary={summary}
        title="User value chain"
        populationLabel="Real User Testing sessions"
        className={className}
      />
    </ErrorBoundary>
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
