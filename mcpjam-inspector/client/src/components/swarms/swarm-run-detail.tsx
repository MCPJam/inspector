/**
 * Dedicated Swarm Run (wave) detail at `/swarms/:swarmId`.
 *
 * Chrome: identity row (back · title · actions) above Findings |
 * Insights | Sessions. Findings is the default landing tab.
 *
 * This page is also where a live run lives once the create wizard is left: the
 * wizard's Running step has no URL, so a finding followed out of it lands here,
 * and the live strip below the header is what says the run is still going —
 * plus, when a session is focused, the one control back to the whole run.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { toast } from "@/lib/toast";
import {
  buildSwarmPath,
  parseSwarmDetailTab,
  routePaths,
  useCurrentSearchParam,
  useAppNavigate,
  type SwarmDetailTab,
} from "@/lib/app-navigation";
import {
  parseSelectionParam,
  serializeSelectionParam,
  type ThemeRef,
} from "@/hooks/scenario-usage-filters";
import { getShareableAppOrigin } from "@/lib/scenario-session";
import {
  SWARM_QUERIES,
  type SwarmOverview,
  type SwarmWaveSignals,
} from "@/lib/swarm-api";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import { InsightsWorkbench } from "@/components/shared/usage-insights/InsightsWorkbench";
import {
  groupRunsIntoSwarmWaves,
  resolveSwarmWave,
  swarmWaveRouteId,
  swarmWaveTitle,
  waveLiveProgress,
  type SwarmWave,
} from "@/components/swarms/swarm-overview-panel";
import { SwarmFindingsTab } from "@/components/swarms/findings/swarm-findings-tab";

const DETAIL_TAB_OPTIONS = [
  { value: "findings" as const, label: "Findings" },
  { value: "insights" as const, label: "Insights" },
  { value: "sessions" as const, label: "Sessions" },
] as const;

export interface SwarmRunDetailProps {
  swarmId: string;
  projectId: string | null;
  /** Avatar-look fields are optional pass-through: SwarmsTab already hands
   * full persona rows, and the Findings tab reads the pixel-golem look. */
  personas: ReadonlyArray<{
    _id: string;
    name: string;
    role?: string;
    avatarShape?: number;
    avatarPalette?: number;
  }>;
  hosts?: ReadonlyArray<{ hostId: string; name: string }>;
  /**
   * Relaunch each non-archived journey in the wave. Parent owns the launch
   * coordinator (idempotency / quota). Returns after all launches settle.
   */
  onRunAgain: (journeyRefIds: string[]) => Promise<void>;
}

export function SwarmRunDetail({
  swarmId,
  projectId,
  personas,
  hosts = [],
  onRunAgain,
}: SwarmRunDetailProps) {
  const navigate = useAppNavigate();
  const tabParam = useCurrentSearchParam("tab");
  const sessionParam = useCurrentSearchParam("session");
  const selParam = useCurrentSearchParam("sel");
  // Pass both tab and session: a `?session=` deep-link without `tab` must open
  // Sessions. Building `?tab=` alone used to strip session and land on Insights.
  const tab: SwarmDetailTab = parseSwarmDetailTab(
    (() => {
      const search = new URLSearchParams();
      if (tabParam) search.set("tab", tabParam);
      if (sessionParam) search.set("session", sessionParam);
      const query = search.toString();
      return query ? `?${query}` : "";
    })()
  );
  const urlSelection = useMemo(() => parseSelectionParam(selParam), [selParam]);
  const [sessionsPersonaFilter, setSessionsPersonaFilter] = useState<
    string | null
  >(null);
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

  // The Findings tab consumes this alongside the wave data. Keep the
  // subscription at the detail-page level so switching tabs does not discard
  // the signal state.
  const waveGroupId = wave?.runs[0]?.swarmRunGroupId;
  const waveSignals = useQuery(
    SWARM_QUERIES.getWaveSignals as any,
    (queryable && waveGroupId
      ? { projectId, swarmRunGroupId: waveGroupId }
      : "skip") as any
  ) as SwarmWaveSignals | null | undefined;

  const handleTabChange = useCallback(
    (next: SwarmDetailTab) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab: next,
          sel: selParam ?? undefined,
        }),
        { replace: true }
      );
    },
    [navigate, selParam, swarmId]
  );

  const handleShare = useCallback(async () => {
    const url = `${getShareableAppOrigin()}${buildSwarmPath(swarmId, {
      tab,
      session: sessionParam ?? undefined,
      sel: selParam ?? undefined,
    })}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }, [selParam, sessionParam, swarmId, tab]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab: "sessions",
          session: sessionId,
          sel: selParam ?? undefined,
        })
      );
    },
    [navigate, selParam, swarmId]
  );

  /**
   * Drop the focused session and show the run itself. Deliberately NOT
   * `replace`: arriving here from a finding pushed an entry, so a viewer who
   * came that way keeps a working browser Back too.
   */
  const handleBackToRun = useCallback(() => {
    navigate(
      buildSwarmPath(swarmId, {
        tab,
        sel: selParam ?? undefined,
      })
    );
  }, [navigate, selParam, swarmId, tab]);

  const handleSelectionChange = useCallback(
    (
      themes: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null
    ) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab,
          session: sessionParam ?? undefined,
          sel: themes ? serializeSelectionParam(themes) : undefined,
        }),
        { replace: true }
      );
    },
    [navigate, sessionParam, swarmId, tab]
  );

  const launchableJourneyIds = useMemo(() => {
    if (!wave) return [];
    return [
      ...new Set(
        wave.runs.filter((r) => !r.journeyArchived).map((r) => r.journeyRefId)
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
  const live = waveLiveProgress(wave.runs);
  // 0% until the fan-out is known — a live run with no session total yet is
  // starting, not complete.
  const livePercent =
    live && live.total > 0
      ? Math.min(100, Math.round((live.done / live.total) * 100))
      : 0;
  const runIds = wave.runs.map((r) => r.runId);
  const runLabels = new Map(wave.runs.map((r) => [r.runId, r.journeyName]));
  const goalLabels = new Map(
    wave.runs.map((r) => [r.journeyRefId, r.journeyName])
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarm-run-detail"
      data-swarm-id={swarmWaveRouteId(wave)}
    >
      <DetailPageHeader
        backLabel="Swarms"
        onBack={() => navigate(routePaths.swarms)}
        backTestId="swarm-run-detail-back"
        title={
          <h1
            className="truncate text-xl font-bold tracking-tight text-foreground"
            data-testid="swarm-run-detail-title"
          >
            {title}
          </h1>
        }
        actions={
          <>
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
          </>
        }
        tabs={{
          value: tab,
          options: DETAIL_TAB_OPTIONS,
          onChange: handleTabChange,
          ariaLabel: "Swarm run view",
          indicatorId: "swarm-run-detail",
        }}
      />

      {/* Rendered OUTSIDE the tab switch, so a session opened from a finding
          still has the run's progress on screen above it. */}
      {live ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 bg-primary/[0.04] px-8 py-2"
          data-testid="swarm-run-detail-live"
          role="status"
        >
          <span className="flex items-center gap-2 text-sm text-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            This swarm is still running
            {live.total > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                — {live.done} of {live.total} sessions
              </span>
            ) : null}
          </span>
          <div
            className="h-1.5 min-w-[6rem] flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={livePercent}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid="swarm-run-detail-live-progress"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${livePercent}%` }}
            />
          </div>
          {sessionParam ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 rounded-lg"
              onClick={() => handleBackToRun()}
              data-testid="swarm-run-detail-back-to-run"
            >
              Back to the live run
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "findings" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            <SwarmFindingsTab
              wave={wave}
              waveSignals={waveSignals}
              personas={personas}
              onOpenSession={handleOpenSession}
              projectId={projectId ?? undefined}
            />
          </div>
        ) : null}
        {tab === "insights" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-8 py-4">
            <div className="min-h-0 flex-1 overflow-hidden">
              <InsightsWorkbench
                scope={
                  projectId
                    ? {
                        kind: "swarm",
                        projectId,
                        ...(runIds.length
                          ? { journeyRunIds: [...runIds] }
                          : {}),
                      }
                    : null
                }
                cohortKey={`${projectId ?? ""}\0${runIds.join("\0")}`}
                onOpenSession={handleOpenSession}
                onOpenSessionsTab={() => handleTabChange("sessions")}
                urlSelection={urlSelection}
                onSelectionChange={handleSelectionChange}
                autoBackfillTopicMap
                emptyState={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {projectId
                      ? "No sessions in this swarm run yet."
                      : "Sign in to view swarm insights."}
                  </div>
                }
                testIdPrefix="swarm-insights"
              />
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
            initialThreadId={sessionParam}
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
