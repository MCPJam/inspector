/**
 * Dedicated Swarm Run (wave) detail at `/swarms/:swarmId`.
 *
 * Chrome: identity row (back · title · settled outcome · tabs · actions).
 * A still-running wave with no `?tab=` opens Run — the same matrix +
 * stream as the create wizard. Findings is the default once the wave has
 * settled. The live strip under the header is only for work in flight
 * (progress + Stop).
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
  StopSwarmRunButton,
  useStopSwarmRun,
} from "@/components/swarms/swarm-stop-run";
import {
  SWARM_QUERIES,
  type SwarmOverview,
  type SwarmOverviewFinding,
  type SwarmWaveSignals,
} from "@/lib/swarm-api";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useRunInsights } from "@/hooks/use-run-insights";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import { InsightsWorkbench } from "@/components/shared/usage-insights/InsightsWorkbench";
import {
  groupRunsIntoSwarmWaves,
  resolveSwarmWave,
  swarmWaveRouteId,
  swarmWaveTitle,
  swarmWaveRunStateChipClass,
  swarmWaveRunStateLabel,
  waveLiveProgress,
  waveRunState,
  waveSessionTotals,
} from "@/components/swarms/swarm-overview-panel";
import { SwarmFindingsTab } from "@/components/swarms/findings/swarm-findings-tab";
import { narratedWaveSummary } from "@/components/swarms/findings/findings-headline";
import { NewSwarmRunningStep } from "@/components/swarms/new-swarm-running-step";
import {
  DETAIL_TAB_OPTIONS,
  launchedRunsFromWave,
  resolveSwarmRunDetailTab,
} from "@/components/swarms/swarm-run-detail-model";

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
   *
   * Resolves to the NEW wave's route id when the parent minted one, so the
   * confirmation can offer a way into the run it just started. `void` is still
   * accepted: a parent that cannot name the new wave simply gets a
   * confirmation with no link, never a dead one.
   */
  onRunAgain: (
    journeyRefIds: string[],
  ) => Promise<{ swarmRunGroupId?: string } | void>;
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
  const findingParam = useCurrentSearchParam("finding");
  // Pass both tab and session: a `?session=` deep-link without `tab` must open
  // Sessions. Building `?tab=` alone used to strip session and land on Insights.
  const parsedTab: SwarmDetailTab = parseSwarmDetailTab(
    (() => {
      const search = new URLSearchParams();
      if (tabParam) search.set("tab", tabParam);
      if (sessionParam) search.set("session", sessionParam);
      const query = search.toString();
      return query ? `?${query}` : "";
    })(),
  );
  const urlSelection = useMemo(() => parseSelectionParam(selParam), [selParam]);
  const [sessionsPersonaFilter, setSessionsPersonaFilter] = useState<
    string | null
  >(null);
  const [runAgainBusy, setRunAgainBusy] = useState(false);

  const queryable = shouldQueryProjectId(projectId);
  const overview = useQuery(
    SWARM_QUERIES.getSwarmOverview as any,
    (queryable ? { projectId } : "skip") as any,
  ) as SwarmOverview | undefined;

  const waves = useMemo(
    () => groupRunsIntoSwarmWaves(overview?.runs ?? []),
    [overview],
  );
  const wave = useMemo(
    () => (overview === undefined ? null : resolveSwarmWave(waves, swarmId)),
    [overview, waves, swarmId],
  );
  const launchedRuns = useMemo(
    () => (wave ? launchedRunsFromWave(wave.runs, personas) : []),
    [personas, wave],
  );
  const liveProgress = useMemo(
    () => (wave ? waveLiveProgress(wave.runs) : null),
    [wave],
  );
  const tab = resolveSwarmRunDetailTab({
    parsed: parsedTab,
    tabParam,
    sessionParam,
    live: liveProgress !== null,
  });

  // The Findings tab consumes this alongside the wave data. Keep the
  // subscription at the detail-page level so switching tabs does not discard
  // the signal state.
  const waveGroupId = wave?.runs[0]?.swarmRunGroupId;
  const waveSignals = useQuery(
    SWARM_QUERIES.getWaveSignals as any,
    (queryable && waveGroupId
      ? { projectId, swarmRunGroupId: waveGroupId }
      : "skip") as any,
  ) as SwarmWaveSignals | null | undefined;

  // Lane A's wave narration, READ-ONLY (`autoRequest: false`). Findings is the
  // default landing tab, so an auto-request here would bill a generation for
  // merely opening a swarm. Generation stays where a person asks for it (the
  // Insights tab) or where the backend schedules it on wave settle
  // (`insightAutoTrigger.checkWaveTerminalAndRequestInsights`).
  const waveInsights = useRunInsights(
    queryable && waveGroupId
      ? {
          kind: "swarm",
          projectId: projectId as string,
          swarmRunGroupId: waveGroupId,
        }
      : null,
    { autoRequest: false },
  );
  const generatedWaveSummary = narratedWaveSummary(
    waveInsights.status,
    waveInsights.insights,
  );

  const handleTabChange = useCallback(
    (next: SwarmDetailTab) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab: next,
          sel: selParam ?? undefined,
        }),
        { replace: true },
      );
    },
    [navigate, selParam, swarmId],
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
    (sessionId: string, criterionId?: string) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab: "sessions",
          session: sessionId,
          sel: selParam ?? undefined,
          finding: criterionId,
        }),
      );
    },
    [navigate, selParam, swarmId],
  );

  const handleOpenFindings = useCallback(() => {
    navigate(
      buildSwarmPath(swarmId, {
        tab: "findings",
        sel: selParam ?? undefined,
      }),
      { replace: true },
    );
  }, [navigate, selParam, swarmId]);

  /**
   * Drop the focused session and show the run itself. Deliberately NOT
   * `replace`: arriving here from a finding pushed an entry, so a viewer who
   * came that way keeps a working browser Back too.
   */
  // Drops the focused session AND the finding that led to it: the way back is
  // to the whole run, not to the run still labelled with one session's check.
  const handleBackToRun = useCallback(() => {
    navigate(
      buildSwarmPath(swarmId, {
        tab: liveProgress
          ? "run"
          : parsedTab === "run"
            ? "findings"
            : parsedTab,
        sel: selParam ?? undefined,
      }),
    );
  }, [liveProgress, navigate, parsedTab, selParam, swarmId]);

  const handleSelectionChange = useCallback(
    (
      themes: ReadonlyArray<Pick<ThemeRef, "dimension" | "clusterId">> | null,
    ) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab,
          session: sessionParam ?? undefined,
          sel: themes ? serializeSelectionParam(themes) : undefined,
        }),
        { replace: true },
      );
    },
    [navigate, sessionParam, swarmId, tab],
  );

  const launchableJourneyIds = useMemo(() => {
    if (!wave) return [];
    return [
      ...new Set(
        wave.runs.filter((r) => !r.journeyArchived).map((r) => r.journeyRefId),
      ),
    ];
  }, [wave]);

  const handleRunAgain = useCallback(async () => {
    if (launchableJourneyIds.length === 0) return;
    setRunAgainBusy(true);
    try {
      const started = await onRunAgain(launchableJourneyIds);
      const goals = launchableJourneyIds.length;
      // "Started 15 goals" reported an internal count and left the viewer on
      // the run they had just relaunched FROM, with no way to the new one. Say
      // what happened, then offer the run itself.
      const nextSwarmId = started?.swarmRunGroupId;
      toast.success(
        goals === 1
          ? "New swarm run started"
          : `New swarm run started — ${goals} goals`,
        nextSwarmId
          ? {
              action: {
                label: "View run",
                onClick: () => navigate(buildSwarmPath(nextSwarmId)),
              },
            }
          : undefined,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start swarm run",
      );
    } finally {
      setRunAgainBusy(false);
    }
  }, [launchableJourneyIds, navigate, onRunAgain]);

  const runningRunIds = useMemo(() => {
    if (!wave) return [];
    return wave.runs
      .filter((run) => run.status === "running" || run.status === "pending")
      .map((run) => run.runId);
  }, [wave]);
  const {
    stop: handleStopRun,
    busy: stopBusy,
    stoppedHere,
  } = useStopSwarmRun(runningRunIds);

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
  const live = liveProgress;
  const dataRunState = waveRunState(wave.runs);
  // `stoppedHere` only overrides a TERMINAL read: between the cancel resolving
  // and the wave query catching up, the runs still say `running`, and claiming
  // "stopped" over a strip that is still counting sessions would be a lie the
  // progress bar contradicts on screen.
  const showStopped = stoppedHere && dataRunState !== "running";
  const sessionTotals = waveSessionTotals(wave.runs);
  /**
   * The finding this viewer followed in, resolved from the wave itself — the URL
   * carries only the criterion id, so a renamed or removed criterion degrades
   * to no banner rather than to a stale sentence.
   */
  const followedFinding: SwarmOverviewFinding | null = findingParam
    ? (wave.runs
        .flatMap((run) => run.findings)
        .find((finding) => finding.criterionId === findingParam) ?? null)
    : null;
  // 0% until the fan-out is known — a live run with no session total yet is
  // starting, not complete.
  const livePercent =
    live && live.total > 0
      ? Math.min(100, Math.round((live.done / live.total) * 100))
      : 0;
  // Every attempt reached a terminal state and only the run row has yet to
  // settle. Saying work is in flight here contradicts the count printed right
  // beside it, which is what BB-76 reported seeing.
  const settling = live !== null && live.total > 0 && live.done >= live.total;
  const runIds = wave.runs.map((r) => r.runId);
  const runLabels = new Map(wave.runs.map((r) => [r.runId, r.journeyName]));
  const goalLabels = new Map(
    wave.runs.map((r) => [r.journeyRefId, r.journeyName]),
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
            title={title}
            data-testid="swarm-run-detail-title"
          >
            {title}
          </h1>
        }
        meta={
          live ? undefined : (
            <div
              className="flex items-center gap-2"
              data-testid="swarm-run-detail-state"
              data-run-state={showStopped ? "stopped" : dataRunState}
              role="status"
            >
              <span
                className={
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                  (showStopped
                    ? "bg-muted text-muted-foreground"
                    : swarmWaveRunStateChipClass(dataRunState))
                }
                data-testid="swarm-run-detail-state-label"
              >
                {showStopped ? "Stopped" : swarmWaveRunStateLabel(dataRunState)}
              </span>
              <span className="truncate text-sm text-muted-foreground">
                {sessionTotals.total > 0
                  ? `${sessionTotals.succeeded} of ${sessionTotals.total}`
                  : "None ran"}
              </span>
            </div>
          )
        }
        actions={
          <>
            {!live && sessionParam ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-lg"
                onClick={() => handleBackToRun()}
                data-testid="swarm-run-detail-back-to-run"
              >
                Back to the run
              </Button>
            ) : null}
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

      {/* Live only. Settled outcome lives in the header so a finished wave
          does not spend a second row repeating Complete + the session tally. */}
      {live ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 bg-primary/[0.04] px-8 py-2"
          data-testid="swarm-run-detail-live"
          data-run-state="running"
          role="status"
        >
          <span className="flex items-center gap-2 text-sm text-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            {settling ? "Finishing up" : "This swarm is still running"}
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
          {/* Confirmed, because a stop cannot be undone: the sessions still
              queued never run, so their results never exist. */}
          <StopSwarmRunButton
            runningCount={runningRunIds.length}
            busy={stopBusy}
            onConfirm={() => void handleStopRun()}
            testIdPrefix="swarm-run-detail"
          />
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

      {/* What the viewer followed in on. Without this, clicking a finding
          handed over a transcript with the claim removed — the evidence, minus
          what it was evidence of. */}
      {followedFinding && sessionParam ? (
        <div
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/40 bg-muted/30 px-8 py-2 text-sm"
          data-testid="swarm-run-detail-followed-finding"
          data-criterion-id={followedFinding.criterionId}
        >
          <span className="text-muted-foreground">Following finding:</span>
          <span className="font-medium text-foreground">
            {followedFinding.label?.trim() ||
              followedFinding.kind ||
              followedFinding.criterionId}
          </span>
          <span className="text-muted-foreground">
            — failed in {followedFinding.failCount} of{" "}
            {followedFinding.sessionsGraded} graded{" "}
            {followedFinding.sessionsGraded === 1 ? "session" : "sessions"}
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "run" && projectId ? (
          <NewSwarmRunningStep
            projectId={projectId}
            runs={launchedRuns}
            fallbackColumns={[]}
            hosts={hosts}
            chrome="page"
            onLeave={handleOpenFindings}
            onOpenSession={handleOpenSession}
          />
        ) : null}
        {tab === "run" && !projectId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Sign in to watch this run.
          </div>
        ) : null}
        {tab === "findings" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            <SwarmFindingsTab
              wave={wave}
              waveSignals={waveSignals}
              personas={personas}
              onOpenSession={handleOpenSession}
              projectId={projectId ?? undefined}
              generatedSummary={generatedWaveSummary}
            />
          </div>
        ) : null}
        {tab === "insights" ? (
          // Scroll the whole Insights tab instead of locking it to the
          // viewport: the Session-flow Sankey was crushed into a sliver on
          // shorter windows, and its many themes could only be reached by
          // dragging a cramped inner scroll. The workbench renders its body at
          // natural height (bodyLayout="scroll") and this container owns the
          // one scrollbar.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-4">
            {/* Flex column at least as tall as the scroll viewport, so the
                workbench grows past it (page scrolls) while its empty state can
                still take a full-height floor and center. */}
            <div className="flex min-h-full flex-col">
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
                bodyLayout="scroll"
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
