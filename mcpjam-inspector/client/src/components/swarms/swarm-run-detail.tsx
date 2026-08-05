/**
 * Dedicated Swarm Run (wave) detail at `/swarms/:swarmId`.
 *
 * Chrome: identity row (back · title · time · actions) above Insights |
 * Sessions. Insights is the default landing tab: persona chips, wave-scoped
 * session-flow Sankey, then rubric findings.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { toast } from "@/lib/toast";
import {
  buildSwarmPath,
  parseSwarmDetailTab,
  routePaths,
  useAppNavigate,
  type SwarmDetailTab,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { SWARM_QUERIES, type SwarmOverview } from "@/lib/swarm-api";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { formatSwarmAbsoluteTime } from "@/components/swarms/journey-run-format";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import { SwarmInsightsPanel } from "@/components/swarms/SwarmInsightsPanel";
import { SwarmRunInsights } from "@/components/swarms/swarm-run-insights";
import {
  groupRunsIntoSwarmWaves,
  resolveSwarmWave,
  swarmWaveRouteId,
  swarmWaveTitle,
  SwarmWaveFindingsList,
  type SwarmWave,
} from "@/components/swarms/swarm-overview-panel";

const DETAIL_TAB_OPTIONS = [
  { value: "insights" as const, label: "Insights" },
  { value: "sessions" as const, label: "Sessions" },
] as const;

export interface SwarmRunDetailProps {
  swarmId: string;
  projectId: string | null;
  personas: ReadonlyArray<{ _id: string; name: string; role?: string }>;
  hosts?: ReadonlyArray<{ hostId: string; name: string }>;
  /**
   * Relaunch each non-archived journey in the wave. Parent owns the launch
   * coordinator (idempotency / quota). Returns after all launches settle.
   */
  onRunAgain: (journeyRefIds: string[]) => Promise<void>;
  /** Jump to list Personas with this persona selected. */
  onOpenPersona: (personaName: string) => void;
}

export function SwarmRunDetail({
  swarmId,
  projectId,
  personas,
  hosts = [],
  onRunAgain,
  onOpenPersona,
}: SwarmRunDetailProps) {
  const navigate = useAppNavigate();
  const [tab, setTab] = useState<SwarmDetailTab>(() =>
    parseSwarmDetailTab(
      typeof window !== "undefined" ? window.location.search : ""
    )
  );
  const [sessionsPersonaFilter, setSessionsPersonaFilter] = useState<
    string | null
  >(null);
  const [drilldownThreadId, setDrilldownThreadId] = useState<string | null>(
    null
  );
  const [runAgainBusy, setRunAgainBusy] = useState(false);

  const queryable = shouldQueryProjectId(projectId);
  const overview = useQuery(
    SWARM_QUERIES.getSwarmOverview as any,
    (queryable ? { projectId } : "skip") as any
  ) as SwarmOverview | undefined;

  const waves = useMemo(
    () => groupRunsIntoSwarmWaves(overview?.runs ?? []),
    [overview]
  );
  const wave = useMemo(
    () => (overview === undefined ? null : resolveSwarmWave(waves, swarmId)),
    [overview, waves, swarmId]
  );

  const handleTabChange = useCallback(
    (next: SwarmDetailTab) => {
      setTab(next);
      navigate(buildSwarmPath(swarmId, next), { replace: true });
    },
    [navigate, swarmId]
  );

  const handleShare = useCallback(async () => {
    const url = `${getShareableAppOrigin()}${buildSwarmPath(swarmId, tab)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }, [swarmId, tab]);

  const handleOpenSession = useCallback((sessionId: string) => {
    setDrilldownThreadId(sessionId);
    setTab("sessions");
    navigate(buildSwarmPath(swarmId, "sessions"), { replace: true });
  }, [navigate, swarmId]);

  const launchableJourneyIds = useMemo(() => {
    if (!wave) return [];
    return [
      ...new Set(
        wave.runs
          .filter((r) => !r.journeyArchived)
          .map((r) => r.journeyRefId)
      ),
    ];
  }, [wave]);

  const handleRunAgain = useCallback(async () => {
    if (launchableJourneyIds.length === 0) return;
    setRunAgainBusy(true);
    try {
      await onRunAgain(launchableJourneyIds);
      toast.success(
        launchableJourneyIds.length === 1
          ? "Swarm run started"
          : `Started ${launchableJourneyIds.length} goals`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start swarm run"
      );
    } finally {
      setRunAgainBusy(false);
    }
  }, [launchableJourneyIds, onRunAgain]);

  if (overview === undefined) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="swarm-run-detail-loading"
      >
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading swarm…
      </div>
    );
  }

  if (!wave) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
        data-testid="swarm-run-detail-missing"
      >
        <p className="text-sm text-muted-foreground">Swarm run not found.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => navigate(routePaths.swarms)}
        >
          Back to Swarms
        </Button>
      </div>
    );
  }

  const title = swarmWaveTitle(wave);
  const runIds = wave.runs.map((r) => r.runId);
  const runLabels = new Map(
    wave.runs.map((r) => [r.runId, r.journeyName])
  );
  const goalLabels = new Map(
    wave.runs.map((r) => [r.journeyRefId, r.journeyName])
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarm-run-detail"
      data-swarm-id={swarmWaveRouteId(wave)}
    >
      <div className="relative shrink-0 border-b border-border/40 px-8 pt-2.5 pb-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <DetailBackLink onBack={() => navigate(routePaths.swarms)} />
            <div
              className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
              aria-hidden="true"
            />
            <div className="flex min-w-0 items-baseline gap-x-2.5">
              <h1
                className="truncate text-xl font-bold tracking-tight text-foreground"
                data-testid="swarm-run-detail-title"
              >
                {title}
              </h1>
              <span
                className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                data-testid="swarm-run-detail-time"
              >
                {formatSwarmAbsoluteTime(wave.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-lg"
              onClick={() => void handleShare()}
              data-testid="swarm-run-detail-share"
            >
              Share
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-lg font-medium"
              disabled={runAgainBusy || launchableJourneyIds.length === 0}
              onClick={() => void handleRunAgain()}
              data-testid="swarm-run-detail-run-again"
            >
              {runAgainBusy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              Run again
            </Button>
          </div>
        </div>
        <ViewModeSelector
          value={tab}
          ariaLabel="Swarm run view"
          indicatorId="swarm-run-detail"
          onChange={handleTabChange}
          options={DETAIL_TAB_OPTIONS}
          className="-ml-3 justify-start overflow-x-visible md:w-auto [&_button]:min-h-9 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm sm:[&_button]:min-h-9 sm:[&_button]:px-3.5 sm:[&_button]:text-sm md:[&_button]:min-h-9 lg:[&_button]:px-4"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "insights" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-8 py-5">
            <DetailPersonasStrip
              wave={wave}
              onOpenPersona={onOpenPersona}
            />
            {/* Insights LEAD the tab. The flow map and scorecard below are
                for exploring; this is the answer, so it sits above them and
                shrinks to its content rather than competing for the viewport.
                Keyed on the durable run id — legacy time-clustered runs have
                none and simply get no insights. */}
            {projectId && wave.runs[0]?.swarmRunGroupId ? (
              <div className="shrink-0">
                <SwarmRunInsights
                  projectId={projectId}
                  swarmRunGroupId={wave.runs[0].swarmRunGroupId}
                  onOpenSession={handleOpenSession}
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <SwarmInsightsPanel
                projectId={projectId}
                journeyRunIds={runIds}
                onOpenSession={handleOpenSession}
                fillViewport
              >
                <SwarmWaveFindingsList
                  runs={wave.runs}
                  onOpenSession={handleOpenSession}
                />
              </SwarmInsightsPanel>
            </div>
          </div>
        ) : null}
        {tab === "sessions" && projectId ? (
          <SwarmsSessionsPanel
            projectId={projectId}
            personas={personas}
            hosts={hosts}
            personaRefId={sessionsPersonaFilter}
            onPersonaRefIdChange={setSessionsPersonaFilter}
            initialThreadId={drilldownThreadId}
            runLabels={runLabels}
            goalLabels={goalLabels}
            journeyRunIds={runIds}
          />
        ) : null}
        {tab === "sessions" && !projectId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Sign in to browse sessions.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailBackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="shrink-0 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      data-testid="swarm-run-detail-back"
    >
      ← Swarms
    </button>
  );
}

/** Compact persona chips for Insights — jump to list Personas on click. */
function DetailPersonasStrip({
  wave,
  onOpenPersona,
}: {
  wave: SwarmWave;
  onOpenPersona: (personaName: string) => void;
}) {
  const rows = useMemo(() => {
    const byName = new Map<string, { name: string; journeyCount: number }>();
    for (const run of wave.runs) {
      const existing = byName.get(run.personaName);
      if (existing) existing.journeyCount += 1;
      else byName.set(run.personaName, { name: run.personaName, journeyCount: 1 });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [wave.runs]);

  if (rows.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="swarm-run-detail-personas"
    >
      <span className="mr-0.5 text-[11px] font-medium text-muted-foreground">
        Personas
      </span>
      {rows.map((row) => (
        <button
          key={row.name}
          type="button"
          title={
            row.journeyCount === 1
              ? row.name
              : `${row.name} · ${row.journeyCount} goals`
          }
          className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium text-foreground/90 transition-colors hover:bg-muted/50 hover:text-foreground"
          onClick={() => onOpenPersona(row.name)}
          data-testid="swarm-run-detail-persona"
        >
          <span className="truncate">{row.name}</span>
          {row.journeyCount > 1 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {row.journeyCount}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
