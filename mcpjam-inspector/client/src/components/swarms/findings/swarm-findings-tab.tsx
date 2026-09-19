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
 */
import { useQuery } from "convex/react";
import { useEffect, useCallback } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import type {
  SwarmJourneyFindings,
  SwarmJourneyFindingsJob,
} from "@mcpjam/sdk/contract";
import { ActionableFindings } from "@/components/shared/actionable-insights/actionable-findings";

import { useMemo, useState } from "react";
import type { SwarmWaveSignals } from "@/lib/swarm-api";
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
  deriveHonestyFootnotes,
  wireFindingsFootnotes,
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
  narration,
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
  // On the shared-findings path the fix comes from the top verified
  // mechanism, never from Lane A's wave prose.
  const recommendation =
    summary.kind === "not_launched"
      ? null
      : journeyFindings
        ? wireRecommendation(journeyFindings)
        : clampNarration(generatedSummary);
  const footnotes = useMemo(
    () =>
      journeyFindings
        ? wireFindingsFootnotes(journeyFindings)
        : deriveHonestyFootnotes({
            narration,
            signals: waveSignals,
            hasGroupId: Boolean(wave.runs[0]?.swarmRunGroupId),
            launch: model.launch,
          }),
    [waveSignals, wave.runs, model.launch, journeyFindings, narration],
  );

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
      : (expandedGoal?.defaultStage ?? "value");

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
        {jobStatus}
        <FindingsSummaryCard
          sessionCount={model.sessionCount}
          summary={summary.lines}
          recommendation={recommendation}
          footnotes={footnotes}
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
      {jobStatus}
      <FindingsSummaryCard
        sessionCount={model.sessionCount}
        summary={summary.lines}
        recommendation={recommendation}
        footnotes={footnotes}
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
      {projectId && (
        <ActionableFindings
          surface={{ kind: "journey_run", projectId, runId: wave.anchor.runId }}
          context={{ rerunLabel: "this swarm" }}
          boundaryName="swarm-actionable-findings"
          onOpenSession={onOpenSession}
        />
      )}
    </div>
  );
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
