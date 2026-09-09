/**
 * The Findings tab on `/user-testing/:scenarioId`.
 *
 * Same page as the swarm's, fed by a different derivation: personas here are
 * sentiments rather than authored people, so it reuses the summary card,
 * persona strip and persona card and swaps only what the surface disagrees
 * about.
 *
 * Two deliberate differences from the swarm tab:
 *
 *  - The persona badge is a session count, not a sentiment pill. The tab title
 *    already names the feeling, so the pill would only repeat it.
 *  - It reads sessions through the goal-outcome drill-down with User Testing's
 *    hide-synthetic policy applied, because that is the population Insights
 *    counts. Reading without it would report a different total for the same
 *    study, which is exactly what BB-145 asks us not to do.
 *
 * The grid is built from one page of sessions. Beyond that page the card
 * footnotes its own coverage rather than presenting a subset as the whole.
 */

import { useMemo, useState } from "react";
import { EMPTY_USAGE_FILTER } from "@/hooks/scenario-usage-filters";
import { useGoalOutcomeDrilldown } from "@/hooks/useUsageInsights";
import { withHideSynthetic } from "@/components/scenarios/user-testing-traffic";
import { FindingsSummaryCard } from "@/components/swarms/findings/findings-summary-card";
import { FindingsPersonaTabs } from "@/components/swarms/findings/findings-persona-tabs";
import { FindingsPersonaCard } from "@/components/swarms/findings/findings-persona-card";
import type { JourneyStageId } from "@/components/swarms/findings/journey-stages";
import {
  deriveScenarioFindingsFootnotes,
  deriveScenarioFindingsModel,
} from "./scenario-findings-derivation";
import { composeScenarioFindingsSummary } from "./scenario-findings-summary";

/**
 * One page. `MAX_LIMIT` server-side is 200, and paging the whole study to build
 * the persona × goal grid would cost a round trip per page on every open. The
 * card reports the shortfall instead.
 */
const GRID_PAGE_SIZE = 200;

export function ScenarioFindingsTab({
  scenarioId,
  onOpenSession,
}: {
  scenarioId: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const filters = useMemo(() => withHideSynthetic(EMPTY_USAGE_FILTER), []);
  const { drilldown, isLoading } = useGoalOutcomeDrilldown({
    scope: { kind: "scenario", scenarioId },
    clusterId: null,
    outcome: undefined,
    filters,
    limit: GRID_PAGE_SIZE,
  });

  const model = useMemo(
    () =>
      deriveScenarioFindingsModel({
        sessions: drilldown?.sessions ?? [],
        sessionCount: drilldown?.total,
        // The server says when it stopped counting; the page length says when
        // we stopped reading. Either one makes the grid a subset.
        truncated:
          drilldown === undefined
            ? false
            : drilldown.totalTruncated ||
              drilldown.sessions.length < drilldown.total,
      }),
    [drilldown]
  );

  const summary = useMemo(
    () => composeScenarioFindingsSummary(model),
    [model]
  );
  const footnotes = useMemo(
    () => deriveScenarioFindingsFootnotes(model),
    [model]
  );

  // Keyed by name rather than index: the strip re-derives as sessions load, and
  // an index would quietly select someone else underneath the reader.
  const [personaChoice, setPersonaChoice] = useState<string | null>(null);
  const [expandedChoice, setExpandedChoice] = useState<{
    personaName: string;
    goalId: string | null;
  } | null>(null);
  const [stageChoice, setStageChoice] = useState<{
    goalId: string;
    stage: JourneyStageId;
  } | null>(null);

  const chosenIndex =
    personaChoice === null
      ? -1
      : model.personas.findIndex((p) => p.name === personaChoice);
  const personaIndex = Math.min(
    chosenIndex >= 0 ? chosenIndex : model.defaultPersonaIndex,
    Math.max(0, model.personas.length - 1)
  );
  const persona = model.personas[personaIndex];

  const expandedGoalId =
    expandedChoice && expandedChoice.personaName === persona?.name
      ? expandedChoice.goalId
      : null;
  const expandedGoal = persona?.goals.find(
    (goal) => goal.runId === expandedGoalId
  );
  const selectedStage: JourneyStageId =
    stageChoice && stageChoice.goalId === expandedGoal?.runId
      ? stageChoice.stage
      : expandedGoal?.defaultStage ?? "value";

  if (isLoading && drilldown === undefined) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="scenario-findings-loading"
      >
        Reading sessions…
      </div>
    );
  }

  if (!persona) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="scenario-findings-empty"
      >
        {model.unanalyzedCount > 0
          ? "No session has been analyzed yet."
          : "No sessions in this study yet."}
      </div>
    );
  }

  return (
    <div className="w-full" data-testid="scenario-findings-tab">
      <FindingsSummaryCard
        sessionCount={model.sessionCount}
        summary={summary}
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
            const next = model.personas[index];
            if (!next) return;
            setPersonaChoice(next.name);
            setExpandedChoice(null);
          }}
          renderBadge={(p) => (
            <span
              className="text-xs text-muted-foreground"
              data-testid="scenario-findings-persona-count"
            >
              {p.sessionsAuthored} session{p.sessionsAuthored === 1 ? "" : "s"}
            </span>
          )}
        />
      </div>
      <FindingsPersonaCard
        persona={persona}
        selectedTabId={`findings-persona-tab-${personaIndex}`}
        expandedGoalRunId={expandedGoalId}
        onToggleGoal={(goalId) =>
          setExpandedChoice({
            personaName: persona.name,
            goalId: expandedGoalId === goalId ? null : goalId,
          })
        }
        selectedStage={selectedStage}
        onSelectStage={(stage) =>
          expandedGoal
            ? setStageChoice({ goalId: expandedGoal.runId, stage })
            : undefined
        }
        onOpenSession={onOpenSession}
      />
    </div>
  );
}
