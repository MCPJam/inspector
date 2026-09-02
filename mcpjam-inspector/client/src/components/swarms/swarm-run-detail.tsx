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
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
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
import { convexErrMessage } from "@/lib/convex-error";

/**
 * Did `cancelJourneyRun` refuse because the run had already settled?
 *
 * The backend answers `ConvexError({ code: 'CONFLICT' })` for any run whose
 * status is no longer `running`. Matched on the structured `code` rather than
 * on the text: Convex redacts `err.message` for an application error to a
 * Request-ID string, so a message regex would silently never match in prod —
 * the payload on `err.data` is the only reliable carrier.
 */
export function isRunAlreadySettled(reason: unknown): boolean {
  if (!reason || typeof reason !== "object" || !("data" in reason)) {
    return false;
  }
  const data = (reason as { data: unknown }).data;
  return (
    !!data &&
    typeof data === "object" &&
    (data as { code?: unknown }).code === "CONFLICT"
  );
}
import {
  SWARM_MUTATIONS,
  SWARM_QUERIES,
  type SwarmOverview,
  type SwarmOverviewFinding,
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
  swarmWaveRunStateChipClass,
  swarmWaveRunStateLabel,
  waveLiveProgress,
  waveRunState,
  waveSessionTotals,
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
   *
   * Resolves to the NEW wave's route id when the parent minted one, so the
   * confirmation can offer a way into the run it just started. `void` is still
   * accepted: a parent that cannot name the new wave simply gets a
   * confirmation with no link, never a dead one.
   */
  onRunAgain: (
    journeyRefIds: string[]
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
  const [stopBusy, setStopBusy] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  /**
   * This viewer stopped the run, in this visit.
   *
   * `getSwarmOverview` projects `status` but not the `error` marker that
   * separates a deliberate stop from a failure, so the wave read cannot tell
   * them apart — it will settle on `failed`. Reporting "Failed" in red to the
   * person who just pressed Stop says their action broke something. This is the
   * one piece of positive evidence available, so it is used, and only for as
   * long as it is trustworthy: a reload has no memory of the click and honestly
   * falls back to what the data supports.
   */
  const [stoppedHere, setStoppedHere] = useState(false);

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
    (sessionId: string, criterionId?: string) => {
      navigate(
        buildSwarmPath(swarmId, {
          tab: "sessions",
          session: sessionId,
          sel: selParam ?? undefined,
          finding: criterionId,
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
  // Drops the focused session AND the finding that led to it: the way back is
  // to the whole run, not to the run still labelled with one session's check.
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
        err instanceof Error ? err.message : "Could not start swarm run"
      );
    } finally {
      setRunAgainBusy(false);
    }
  }, [launchableJourneyIds, navigate, onRunAgain]);

  const cancelJourneyRun = useMutation(
    SWARM_MUTATIONS.cancelJourneyRun as any,
  );

  const runningRunIds = useMemo(() => {
    if (!wave) return [];
    return wave.runs
      .filter((run) => run.status === "running" || run.status === "pending")
      .map((run) => run.runId);
  }, [wave]);

  /**
   * Stop every still-running goal in this wave.
   *
   * A wave is N journey-runs, and the backend cancels ONE run per call, so a
   * partial outcome is possible: `allSettled` rather than `all`, and the report
   * names how many actually stopped instead of claiming the whole wave on the
   * strength of the first success.
   *
   * Three outcomes per goal, not two. `cancelJourneyRun` throws `CONFLICT` for
   * a goal that settled between the click and the call, and that is neither a
   * success nor a refusal: nothing is running, so it is not a goal that "could
   * not be stopped", but this viewer did not stop it either. Counting it as a
   * failure produced an error toast for a run that had, in the viewer's terms,
   * already done what they asked; counting it as a success would put "Stopped"
   * over a goal that COMPLETED, which the backend calls materially wrong.
   */
  const handleStopRun = useCallback(async () => {
    if (runningRunIds.length === 0) return;
    setStopConfirmOpen(false);
    setStopBusy(true);
    try {
      const results = await Promise.allSettled(
        runningRunIds.map((runId) =>
          cancelJourneyRun({ journeyRunId: runId } as any),
        ),
      );
      const rejections = results.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : [],
      );
      // A goal that settled between the click and the call answers `CONFLICT`.
      // That is not a refusal — nothing is running any more, which is what the
      // viewer asked for — so it must not be counted as a goal that "could not
      // be stopped". Read off the structured `code`, not the message: for an
      // application error Convex redacts `err.message` to a Request-ID string,
      // which is also why the toast below goes through `convexErrMessage`.
      const refused = rejections.filter(
        (reason) => !isRunAlreadySettled(reason),
      );
      const canceled = results.length - rejections.length;

      // A real refusal outranks the already-settled case. With nothing stopped
      // and one goal genuinely refused, ordering these the other way reported
      // "already finished" and buried the failure the viewer has to act on.
      if (canceled === 0 && refused.length > 0) {
        toast.error(convexErrMessage(refused[0], "Could not stop the run"));
        return;
      }
      if (canceled === 0) {
        // Every goal had already finished on its own. Nothing is running, but
        // this viewer did not stop it — claiming otherwise would be wrong for a
        // goal that COMPLETED, and would leave the strip reading "Stopped" over
        // a run that succeeded. So: no `stoppedHere`, and not an error either.
        toast.info("Run had already finished");
        return;
      }
      setStoppedHere(true);
      toast.success(
        refused.length === 0
          ? "Run stopped"
          : `Run stopped — ${refused.length} ${
              refused.length === 1 ? "goal" : "goals"
            } could not be stopped`,
      );
    } finally {
      setStopBusy(false);
    }
  }, [cancelJourneyRun, runningRunIds]);

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
          still has the run's state on screen above it — and ALWAYS rendered,
          terminal included: a viewer returning to this page had no way to tell
          an active run from a finished one, and the way back out of a focused
          session existed only while the run happened to still be going. */}
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
              queued never run, so their results never exist. A Popover rather
              than a modal, so the run stays visible behind the decision. */}
          <Popover open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-lg"
                disabled={stopBusy || runningRunIds.length === 0}
                data-testid="swarm-run-detail-stop"
              >
                {stopBusy ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : null}
                Stop run
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 max-w-[90vw] p-3">
              <p className="text-sm text-foreground">
                Stop this run? Sessions that have not started yet will not run.
                Results already collected are kept.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setStopConfirmOpen(false)}
                >
                  Keep running
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => void handleStopRun()}
                  data-testid="swarm-run-detail-stop-confirm"
                >
                  Stop run
                </Button>
              </div>
            </PopoverContent>
          </Popover>
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
      ) : (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-8 py-2"
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
          <span className="text-sm text-muted-foreground">
            {sessionTotals.total > 0
              ? `${sessionTotals.succeeded} of ${sessionTotals.total} sessions succeeded`
              : "No sessions ran"}
          </span>
          <span className="flex-1" />
          {sessionParam ? (
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
        </div>
      )}

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
