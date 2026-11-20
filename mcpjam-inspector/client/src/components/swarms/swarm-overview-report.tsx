import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@mcpjam/design-system/button";
import { useInsightsEnvelope } from "@/components/shared/actionable-insights/use-insights-envelope";
import { SessionFlowSankey } from "@/components/shared/usage-insights/SessionFlowSankey";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import {
  EMPTY_USAGE_FILTER,
  isSameSelection,
  type InsightsSelection,
} from "@/hooks/scenario-usage-filters";
import { useRunInsights } from "@/hooks/use-run-insights";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { SWARM_QUERIES, type SwarmWaveSignals } from "@/lib/swarm-api";
import type { FindingsPersonaDoc } from "./findings/findings-derivation";
import { narratedWaveSummary } from "./findings/findings-headline";
import { SwarmFindingsTab } from "./findings/swarm-findings-tab";
import { formatWaveModelLabel, WaveClientLogoStrip } from "./swarm-overview-panel";
import type { OverviewWave } from "./swarm-overview-workspace";

const waveSignalsQuery = makeFunctionReference<
  "query",
  { projectId: string; swarmRunGroupId: string },
  SwarmWaveSignals | null
>(SWARM_QUERIES.getWaveSignals);

function Metadata({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{children}</dd>
    </div>
  );
}

export function SwarmOverviewReport({
  row,
  projectId,
  personas,
  hostStyleByName,
  showEnvironment,
  onOpenSwarm,
}: {
  row: OverviewWave;
  projectId: string;
  personas: readonly FindingsPersonaDoc[];
  hostStyleByName: ReadonlyMap<string, string | null | undefined>;
  showEnvironment: boolean;
  onOpenSwarm: (id: string) => void;
}) {
  return (
    <article
      className="@container h-full overflow-y-auto bg-background p-4 sm:p-6"
      data-testid="swarm-overview-report"
    >
      <header className="mb-5 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="min-w-0 break-words text-xl font-semibold leading-tight">{row.heading}</h2>
              {row.date && <span className="text-sm text-foreground/75">{row.date}</span>}
            </div>
            {row.title && <p className="break-words text-sm text-muted-foreground">{row.title}</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => onOpenSwarm(row.id)}>
            Open full swarm
          </Button>
        </div>
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          <Metadata label="Sessions">
            <span className="tabular-nums">
              {row.totals.succeeded}/{row.totals.total} complete
            </span>
          </Metadata>
          {row.clients.length > 0 && (
            <Metadata label="Clients">
              <WaveClientLogoStrip targets={row.targets} hostStyleByName={hostStyleByName} />
            </Metadata>
          )}
          {row.targets.length > 0 && (
            <Metadata label="Model">
              <span className="font-mono text-xs">{formatWaveModelLabel(row.targets)}</span>
            </Metadata>
          )}
          {showEnvironment && row.environments.length > 0 && (
            <Metadata label="Environment">{row.environments.join(", ")}</Metadata>
          )}
        </dl>
      </header>
      <section aria-labelledby="swarm-overview-findings" className="space-y-2">
        <h3 id="swarm-overview-findings" className="px-0.5 text-sm font-semibold">
          Findings
        </h3>
        <div
          className="max-h-[min(55dvh,32rem)] overflow-y-auto rounded-lg p-0.5"
          data-testid="swarm-overview-findings"
        >
          <ErrorBoundary
            fallback={
              <p className="text-sm text-muted-foreground">
                Couldn't load findings. Open the full swarm to view this run.
              </p>
            }
          >
            <OverviewFindings row={row} projectId={projectId} personas={personas} />
          </ErrorBoundary>
        </div>
      </section>
      <section aria-labelledby="swarm-overview-flow" className="mt-5 space-y-2">
        <h3 id="swarm-overview-flow" className="px-0.5 text-sm font-semibold">
          Session flow
        </h3>
        <ErrorBoundary
          fallback={
            <p className="text-sm text-muted-foreground">
              Couldn't load session flow. Open the full swarm to view this run.
            </p>
          }
        >
          <OverviewSessionFlow row={row} projectId={projectId} />
        </ErrorBoundary>
      </section>
    </article>
  );
}

function OverviewFindings({
  row,
  projectId,
  personas,
}: {
  row: OverviewWave;
  projectId: string;
  personas: readonly FindingsPersonaDoc[];
}) {
  const waveGroupId = row.wave.anchor.swarmRunGroupId;
  const signals = useQuery(
    waveSignalsQuery,
    waveGroupId ? { projectId, swarmRunGroupId: waveGroupId } : "skip",
  );
  const insights = useRunInsights(
    waveGroupId
      ? {
          kind: "swarm",
          projectId,
          swarmRunGroupId: waveGroupId,
        }
      : null,
    { autoRequest: false },
  );
  const envelope = useInsightsEnvelope({
    kind: "journey_run",
    projectId,
    runId: row.wave.anchor.runId,
  });
  return (
    <SwarmFindingsTab
      overview
      wave={row.wave}
      personas={personas}
      projectId={projectId}
      waveSignals={signals}
      generatedSummary={narratedWaveSummary(insights.status, insights.insights)}
      journeyFindings={envelope?.journeyFindings}
      journeyFindingsJob={envelope?.journeyFindingsJob}
    />
  );
}

function OverviewSessionFlow({ row, projectId }: { row: OverviewWave; projectId: string }) {
  const { breakdown } = useUsageInsights({
    scope: {
      kind: "swarm",
      projectId,
      journeyRunIds: row.wave.runs.map((run) => run.runId),
    },
    filters: EMPTY_USAGE_FILTER,
    threadsEnabled: false,
  });
  const [selection, setSelection] = useState<InsightsSelection | null>(null);
  const selectFlow = (next: InsightsSelection) =>
    setSelection((current) => (isSameSelection(current, next) ? null : next));
  if (breakdown === null) {
    return <p className="text-sm text-muted-foreground">No session flow yet.</p>;
  }
  return (
    <SessionFlowSankey
      hideTitle
      goalGroupsByJourney
      scrollLayout
      breakdown={breakdown}
      selection={selection}
      onSelectNode={selectFlow}
      onSelectLink={selectFlow}
      rebuildBusy={false}
      stageOrderKey="swarm-overview"
    />
  );
}
