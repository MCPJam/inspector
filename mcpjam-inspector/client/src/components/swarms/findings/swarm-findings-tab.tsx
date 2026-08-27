/**
 * The Findings tab on `/swarms/:swarmId` — the persona-journey narrative over
 * the wave. Consumes ZERO new queries: everything derives from the `wave`,
 * `waveSignals`, and `personas` the detail page already holds, through the
 * pure `deriveSwarmFindingsModel`.
 *
 * Selection state is local and defaults to collapsed goals. User choices are
 * keyed to what they were made on (persona name / run id), so a live wave
 * re-deriving the model never teleports the reader.
 */

import { useMemo, useState } from "react";
import type { SwarmWaveSignals } from "@/lib/swarm-api";
import type { SwarmWave } from "@/components/swarms/swarm-overview-panel";
import {
  deriveSwarmFindingsModel,
  type FindingsPersonaDoc,
} from "./findings-derivation";
import {
  composeFindingsHeadline,
  deriveHonestyFootnotes,
} from "./findings-headline";
import type { JourneyStageId } from "./journey-stages";
import { FindingsSummaryCard } from "./findings-summary-card";
import { FindingsPersonaTabs } from "./findings-persona-tabs";
import { FindingsPersonaCard } from "./findings-persona-card";

export function SwarmFindingsTab({
  wave,
  waveSignals,
  personas,
  onOpenSession,
}: {
  wave: SwarmWave;
  waveSignals: SwarmWaveSignals | null | undefined;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const model = useMemo(
    () =>
      deriveSwarmFindingsModel({
        runs: wave.runs,
        signals: waveSignals,
        personas,
      }),
    [wave.runs, waveSignals, personas]
  );
  const headline = useMemo(() => composeFindingsHeadline(model), [model]);
  const footnotes = useMemo(
    () =>
      deriveHonestyFootnotes({
        signals: waveSignals,
        hasGroupId: Boolean(wave.runs[0]?.swarmRunGroupId),
      }),
    [waveSignals, wave.runs]
  );

  const [personaChoice, setPersonaChoice] = useState<number | null>(null);
  const [expandedChoice, setExpandedChoice] = useState<{
    personaName: string;
    runId: string | null;
  } | null>(null);
  const [stageChoice, setStageChoice] = useState<{
    runId: string;
    stage: JourneyStageId;
  } | null>(null);

  const personaIndex = Math.min(
    personaChoice ?? model.defaultPersonaIndex,
    Math.max(0, model.personas.length - 1)
  );
  const persona = model.personas[personaIndex];

  const defaultExpanded = null;
  const expandedGoalRunId =
    expandedChoice && expandedChoice.personaName === persona?.name
      ? expandedChoice.runId
      : defaultExpanded;
  const expandedGoal = persona?.goals.find(
    (goal) => goal.runId === expandedGoalRunId
  );
  const selectedStage: JourneyStageId =
    stageChoice && stageChoice.runId === expandedGoal?.runId
      ? stageChoice.stage
      : expandedGoal?.defaultStage ?? "value";

  if (!persona) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="findings-empty"
      >
        No findings yet — no sessions in this swarm run.
      </div>
    );
  }

  return (
    <div className="w-full" data-testid="swarm-findings-tab">
      <FindingsSummaryCard
        sessionCount={model.sessionCount}
        headline={headline}
        footnotes={footnotes}
      />
      <p className="mb-2.5 mt-7 text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground">
        Choose a persona
      </p>
      <div className="mb-3">
        <FindingsPersonaTabs
          personas={model.personas}
          selectedIndex={personaIndex}
          onSelect={(index) => {
            setPersonaChoice(index);
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
      />
    </div>
  );
}
