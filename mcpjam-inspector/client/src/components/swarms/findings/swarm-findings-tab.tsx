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
 * It renders BESIDE the template, never instead of it. Lane A is prompted for
 * the Insights tab's recommendations rail, so it writes in the voice of a fix
 * ("The main fix is to…") and names no goal, persona or stage — promoting it
 * to the headline deletes the four answers this card owes the reader. It is
 * suppressed entirely on a wave that failed to launch: there is no session for
 * a model to have read, and it will cheerfully report that nothing is wrong.
 */

import { useMemo, useState } from "react";
import type { SwarmWaveSignals } from "@/lib/swarm-api";
import type { SwarmWave } from "@/components/swarms/swarm-overview-panel";
import {
  deriveSwarmFindingsModel,
  runIsTerminal,
  type FindingsPersonaDoc,
} from "./findings-derivation";
import {
  clampNarration,
  composeFindingsSummary,
  deriveHonestyFootnotes,
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
}: {
  wave: SwarmWave;
  waveSignals: SwarmWaveSignals | null | undefined;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  onOpenSession?: (sessionId: string) => void;
  projectId?: string;
  /** Lane A's completed wave narration, else null. Never requested here. */
  generatedSummary?: string | null;
}) {
  const model = useMemo(
    () =>
      deriveSwarmFindingsModel({
        runs: wave.runs,
        signals: waveSignals,
        personas,
      }),
    [wave.runs, waveSignals, personas],
  );
  // Signals carry the authoritative answer. A legacy wave has none, so fall
  // back to the runs themselves rather than hiding that the run finished.
  const summary = useMemo(
    () =>
      composeFindingsSummary(model, {
        terminal: waveSignals
          ? waveSignals.terminal
          : wave.runs.every(runIsTerminal),
      }),
    [model, waveSignals, wave.runs],
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
  const recommendation =
    summary.kind === "not_launched" ? null : clampNarration(generatedSummary);
  const footnotes = useMemo(
    () =>
      deriveHonestyFootnotes({
        signals: waveSignals,
        hasGroupId: Boolean(wave.runs[0]?.swarmRunGroupId),
        launch: model.launch,
        generatedSummary: recommendation !== null,
      }),
    [waveSignals, wave.runs, model.launch, recommendation],
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

  if (!persona) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="findings-empty"
      >
        No sessions in this swarm run.
      </div>
    );
  }

  return (
    <div className="w-full" data-testid="swarm-findings-tab">
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
    </div>
  );
}
