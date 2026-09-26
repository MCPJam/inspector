/**
 * The Findings tab on `/swarms/:swarmId` — the persona-journey narrative over
 * the wave. The model derives from the `wave`, `waveSignals`, and `personas`
 * the detail page already holds (`deriveSwarmFindingsModel`). Expanding a
 * goal optionally pages that run's sessions so they can be opened the same
 * way Insights' GoalOutcomeDrilldown does.
 *
 * Selection state is local and defaults to collapsed goals. User choices are
 * keyed to what they were made on (persona name / run id), so a live wave
 * re-deriving the model never teleports the reader.
 *
 * `generatedSummary` is Lane A's wave narration (`SwarmWaveInsights.summary`),
 * read-only: the detail page subscribes with `autoRequest: false`, because
 * Findings is the DEFAULT landing tab and landing on a tab must never start a
 * billed generation.
 *
 * When present it is the summary headline — Lane A is already prompted as a
 * suggested fix. It is suppressed entirely on a wave that failed to launch:
 * there is no session for a model to have read, and it will cheerfully report
 * that nothing is wrong.
 *
 * The tab ends at the persona cards. It used to go on to the shared
 * actionable-findings list ("Fix in your MCP server", "Agent and prompt"), and
 * product asked for that list to be removed here (PLB-29). Evals keep it.
 */
import { useQuery } from "convex/react";
import { useEffect, useCallback } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import type {
  SwarmJourneyFindings,
  SwarmJourneyFindingsJob,
} from "@mcpjam/sdk/contract";

import { useMemo, useState } from "react";
import {
  SWARM_QUERIES,
  type RunLaunchFailures,
  type SwarmWaveSignals,
} from "@/lib/swarm-api";
import { describeLaunchFailures } from "@/components/swarms/swarm-session-not-run";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import { reportCaught } from "@/lib/error-reporting";
import type { SwarmWave } from "@/components/swarms/swarm-overview-panel";
import {
  deriveSwarmFindingsModel,
  deriveSwarmFindingsModelFromWire,
  runIsTerminal,
  wireRecommendation,
  type FindingsPersonaDoc,
} from "./findings-derivation";
import {
  clampNarration,
  composeFindingsSummary,
  composeWireFindingsSummary,
  type SwarmNarration,
} from "./findings-headline";
import type { JourneyStageId } from "./journey-stages";
import { SectionLabel } from "@/components/shared/section-label";
import { FindingsSummaryCard } from "./findings-summary-card";
import { FindingsPersonaTabs } from "./findings-persona-tabs";
import { FindingsPersonaCard } from "./findings-persona-card";

export function SwarmFindingsTab({
  wave,
  waveSignals,
  personas,
  onOpenSession,
  projectId,
  generatedSummary,
  journeyFindings,
  journeyFindingsJob,
}: {
  wave: SwarmWave;
  waveSignals: SwarmWaveSignals | null | undefined;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  onOpenSession?: (sessionId: string) => void;
  projectId?: string;
  /** Lane A's completed wave narration, else null. Never requested here. */
  generatedSummary?: string | null;
  journeyFindings?: SwarmJourneyFindings | null;
  journeyFindingsJob?: SwarmJourneyFindingsJob | null;
  narration?: SwarmNarration;
}) {
  const [funnels, setFunnels] = useState<
    Record<string, ChatSessionStageFunnel | null>
  >({});
  const receiveFunnel = useCallback(
    (id: string, funnel: ChatSessionStageFunnel | null) => {
      setFunnels((old) =>
        old[id] === funnel ? old : { ...old, [id]: funnel },
      );
    },
    [],
  );
  const model = useMemo(
    () =>
      journeyFindings
        ? deriveSwarmFindingsModelFromWire({
            journeyFindings,
            personas,
            runs: wave.runs,
          })
        : deriveSwarmFindingsModel({
            runs: wave.runs,
            signals: waveSignals,
            personas,
            funnels,
          }),
    [wave.runs, waveSignals, personas, funnels, journeyFindings],
  );
  // Signals carry the authoritative answer. A legacy wave has none, so fall
  // back to the runs themselves rather than hiding that the run finished.
  const terminal = waveSignals
    ? waveSignals.terminal
    : wave.runs.every(runIsTerminal);
  const summary = useMemo(
    () =>
      journeyFindings
        ? composeWireFindingsSummary(journeyFindings, model, { terminal })
        : composeFindingsSummary(model, { terminal }),
    [model, terminal, journeyFindings],
  );
  // Swarm keys a goal by its run, so the scope is just the project. Memoized
  // because it reaches a query's arguments through the goal inspect panel.
  const sessionScope = useMemo(
    () => (projectId ? ({ kind: "swarm", projectId } as const) : undefined),
    [projectId],
  );
  // A model may narrate anything EXCEPT a wave that never launched: Lane A
  // would be narrating sessions that do not exist. Observed on a dev wave
  // whose ten runs all failed to launch — "No anomalies concentrated along any
  // dimension of this wave. Nothing to act on." is exactly the reassurance the
  // reader must not be given.
  // On the shared-findings path the fix comes from the cause the headline
  // named, and rides its own labelled line. Lane A's wave prose is not a fix
  // and keeps its old behaviour of replacing the composed paragraph.
  const recommendation =
    summary.kind === "not_launched" || !journeyFindings
      ? null
      : wireRecommendation(journeyFindings);
  const waveProse =
    summary.kind === "not_launched" || journeyFindings
      ? null
      : clampNarration(generatedSummary);

  // Why any of the wave's sessions never ran (#5188). The summary can only
  // count them; the refusal itself is on the attempt rows. Read only when a
  // session did not start, so an ordinary wave issues no extra query.
  const someSessionsDidNotStart =
    model.launch.failed + model.launch.rateLimited > 0;
  const runIds = useMemo(() => wave.runs.map((run) => run.runId), [wave.runs]);
  // Keyed to the runs it was read for, so a reason read for one wave is never
  // shown on the next while that one's read is still in flight.
  const runKey = runIds.join("\0");
  const [launchFailures, setLaunchFailures] = useState<{
    runKey: string;
    value: RunLaunchFailures[];
  } | null>(null);
  const receiveLaunchFailures = useCallback(
    (value: RunLaunchFailures[]) =>
      // Bails out on an equal answer. The effect that calls this keys on the
      // query result, so a source that re-allocates an unchanged answer would
      // otherwise loop: set state, render, new object, set state.
      setLaunchFailures((prev) =>
        prev?.runKey === runKey &&
        JSON.stringify(prev.value) === JSON.stringify(value)
          ? prev
          : { runKey, value },
      ),
    [runKey],
  );
  const launchReason =
    someSessionsDidNotStart && launchFailures?.runKey === runKey
      ? describeLaunchFailures(launchFailures.value)
      : null;
  // A backend that predates the query throws on subscribe; the boundary turns
  // that into no reason line rather than a broken tab, without filing the
  // expected dark ship as an error. Keyed to the wave, so one failed read does
  // not leave the line off every later wave this tab shows.
  const launchFailuresRead = someSessionsDidNotStart ? (
    <ErrorBoundary
      key={runKey}
      fallback={null}
      isExpectedError={isLaunchFailuresUnavailable}
      onError={reportAmbiguousLaunchFailuresError}
    >
      <LaunchFailuresRead runIds={runIds} onRead={receiveLaunchFailures} />
    </ErrorBoundary>
  ) : null;

  // Keyed by name, not index: `deriveSwarmFindingsModel` sorts personas
  // alphabetically, so a live wave adding a persona would shift indices under
  // the reader and silently select someone else.
  const [personaChoice, setPersonaChoice] = useState<string | null>(null);
  const [expandedChoice, setExpandedChoice] = useState<{
    personaName: string;
    runId: string | null;
  } | null>(null);
  const [stageChoice, setStageChoice] = useState<{
    runId: string;
    stage: JourneyStageId;
  } | null>(null);

  const chosenIndex =
    personaChoice === null
      ? -1
      : model.personas.findIndex((p) => p.name === personaChoice);
  const personaIndex = Math.min(
    chosenIndex >= 0 ? chosenIndex : model.defaultPersonaIndex,
    Math.max(0, model.personas.length - 1),
  );
  const persona = model.personas[personaIndex];

  const defaultExpanded = null;
  const expandedGoalRunId =
    expandedChoice && expandedChoice.personaName === persona?.name
      ? expandedChoice.runId
      : defaultExpanded;
  const expandedGoal = persona?.goals.find(
    (goal) => goal.runId === expandedGoalRunId,
  );
  const selectedStage: JourneyStageId =
    stageChoice && stageChoice.runId === expandedGoal?.runId
      ? stageChoice.stage
      : expandedGoal?.defaultStage ?? "value";

  const jobStatus = journeyFindingsJob &&
    journeyFindingsJob.status !== "completed" && (
      <p className="mb-3 text-sm text-muted-foreground">
        {journeyFindingsJob.status === "pending"
          ? "Reading session evidence…"
          : journeyFindingsJob.status === "failed"
          ? "Session analysis did not complete."
          : "Session analysis was skipped."}
      </p>
    );

  if (!persona) {
    // No persona to show. With a wire payload the summary card still has
    // something true to say (e.g. "No sessions launched."); without one there
    // is genuinely nothing here, and an empty card would read as a finding.
    if (!journeyFindings) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center text-sm text-muted-foreground"
          data-testid="findings-empty"
        >
          {jobStatus}
          No sessions in this swarm run.
        </div>
      );
    }
    return (
      <div data-testid="swarm-findings-tab">
        {launchFailuresRead}
        {jobStatus}
        <FindingsSummaryCard
          sessionCount={model.sessionCount}
          summary={summary.lines}
          recommendation={recommendation}
          narration={waveProse}
          launchReason={launchReason}
        />
      </div>
    );
  }

  return (
    <div className="w-full" data-testid="swarm-findings-tab">
      <ErrorBoundary fallback={null}>
        {!journeyFindings &&
          wave.runs.map((run) => (
            <RunFunnelRead
              key={run.runId}
              runId={run.runId}
              onRead={receiveFunnel}
            />
          ))}
      </ErrorBoundary>
      {launchFailuresRead}
      {jobStatus}
      <FindingsSummaryCard
        sessionCount={model.sessionCount}
        summary={summary.lines}
        recommendation={recommendation}
        narration={waveProse}
        launchReason={launchReason}
      />
      <SectionLabel className="mb-2.5 mt-7">Choose a persona</SectionLabel>
      <div className="mb-3">
        <FindingsPersonaTabs
          personas={model.personas}
          selectedIndex={personaIndex}
          onSelect={(index) => {
            const next = model.personas[index];
            if (!next) return;
            setPersonaChoice(next.name);
            setExpandedChoice(null);
          }}
        />
      </div>
      <FindingsPersonaCard
        persona={persona}
        selectedTabId={`findings-persona-tab-${personaIndex}`}
        expandedGoalRunId={expandedGoalRunId}
        onToggleGoal={(runId) =>
          setExpandedChoice({
            personaName: persona.name,
            runId: expandedGoalRunId === runId ? null : runId,
          })
        }
        selectedStage={selectedStage}
        onSelectStage={(stage) =>
          expandedGoal
            ? setStageChoice({ runId: expandedGoal.runId, stage })
            : undefined
        }
        onOpenSession={onOpenSession}
        sessionScope={sessionScope}
      />
    </div>
  );
}

/**
 * The failure the launch-failures read EXPECTS: a deployment that does not
 * serve the query yet (it ships with the backend half of #5188), or a browser
 * outliving a rollback.
 *
 * `isConvexQueryUnavailable` names only the DEV shapes; production redacts
 * every non-`ConvexError` to `[CONVEX Q(<name>)] [Request ID: …] Server Error`,
 * so a redacted failure of THIS query is read as the dark-ship state, as
 * `ServerUrlChangeHistory` does for its own. A `ConvexError` from it (the
 * run-count refusal) carries its own message and still reports.
 */
export function isLaunchFailuresUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message.includes(`Q(${SWARM_QUERIES.listRunLaunchFailures})`))
    return false;
  return isConvexQueryUnavailable(error) || message.includes("Server Error");
}

/** Set once the redacted form has been reported on this page load. */
let reportedRedactedLaunchFailures = false;

/**
 * The redacted production form is ambiguous: a query not deployed yet, or a
 * real crash inside it, which the redaction makes impossible to tell apart.
 * It stays off the error path, so a deploy window does not file an issue per
 * visit, but one info-level report per page load keeps a real crash visible
 * once the backend has shipped. The DEV "not deployed" shape says exactly
 * what it is and is never reported.
 */
export function reportAmbiguousLaunchFailuresError(error: Error): void {
  if (reportedRedactedLaunchFailures) return;
  if (!isLaunchFailuresUnavailable(error) || isConvexQueryUnavailable(error))
    return;
  reportedRedactedLaunchFailures = true;
  reportCaught(error, {
    source: "swarm_launch_failures_redacted",
    level: "info",
  });
}

function LaunchFailuresRead({
  runIds,
  onRead,
}: {
  runIds: readonly string[];
  onRead: (value: RunLaunchFailures[]) => void;
}) {
  const value = useQuery(
    SWARM_QUERIES.listRunLaunchFailures as never,
    { journeyRunIds: runIds } as never,
  ) as RunLaunchFailures[] | undefined;
  useEffect(() => {
    if (value !== undefined) onRead(value);
  }, [value, onRead]);
  return null;
}

function RunFunnelRead({
  runId,
  onRead,
}: {
  runId: string;
  onRead: (id: string, value: ChatSessionStageFunnel | null) => void;
}) {
  const value = useQuery(
    "chatSessionStageDerivation:getSwarmRunStageFunnel" as never,
    { journeyRunId: runId } as never,
  ) as ChatSessionStageFunnel | null | undefined;
  useEffect(() => {
    if (value !== undefined) onRead(runId, value);
  }, [runId, value, onRead]);
  return null;
}
