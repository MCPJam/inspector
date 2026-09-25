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
 * The grid is built from one page of sessions. Beyond that page the
 * persona panel still describes the sessions it has, not the whole study.
 */

import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  EMPTY_USAGE_FILTER,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";
import {
  useGoalOutcomeDrilldown,
  useUsageInsights,
} from "@/hooks/useUsageInsights";
import { withHideSynthetic } from "@/components/scenarios/user-testing-traffic";
import { SectionLabel } from "@/components/shared/section-label";
import { FindingsSummaryCard } from "@/components/swarms/findings/findings-summary-card";
import { FindingsPersonaTabs } from "@/components/swarms/findings/findings-persona-tabs";
import { FindingsPersonaCard } from "@/components/swarms/findings/findings-persona-card";
import type { JourneyStageId } from "@/components/swarms/findings/journey-stages";
import { deriveScenarioFindingsModel } from "./scenario-findings-derivation";
import { composeScenarioFindingsSummary } from "./scenario-findings-summary";
import { ScenarioGoalChain } from "./scenario-goal-chain";
import type { ScenarioGoalStages } from "./scenario-findings-stages";
import { useInsightsRebuild } from "@/hooks/useInsightsFlowController";
import { analysisStatus } from "@/components/shared/usage-insights/analysis-status";
import { AnalysisStatusPanel } from "@/components/shared/usage-insights/analysis-status-panel";

/**
 * One page. `MAX_LIMIT` server-side is 200, and paging the whole study to build
 * the persona × goal grid would cost a round trip per page on every open. The
 * card reports the shortfall instead.
 */
const GRID_PAGE_SIZE = 200;

export function ScenarioFindingsTab({
  scenarioId,
  onOpenSession,
  emptyState,
}: {
  scenarioId: string;
  onOpenSession?: (sessionId: string) => void;
  /**
   * What a study with NO sessions shows, in place of the one-line notice.
   * The detail page passes Insights' own empty panel, so the two tabs of an
   * unrun study say the same thing and offer the same way to get a first
   * session. Only the no-sessions case: sessions still waiting on analysis
   * keep their status panel, which is about a different problem.
   */
  emptyState?: ReactNode;
}) {
  const filters = useMemo(() => withHideSynthetic(EMPTY_USAGE_FILTER), []);
  const { drilldown, isLoading } = useGoalOutcomeDrilldown({
    scope: { kind: "scenario", scenarioId },
    clusterId: null,
    outcome: undefined,
    filters,
    limit: GRID_PAGE_SIZE,
  });

  /**
   * This tab analyzes itself too (BB-196).
   *
   * It is the LANDING tab, so it is the surface most people see first — and
   * the drill-down alone cannot tell "never analyzed" from "analyzed and
   * empty", which is why the breakdown is read here as well: `latestRun` is
   * the only honest signal for the former. Same hook and same one-attempt
   * discipline as the Insights workbench.
   */
  const { breakdown, rebuild } = useUsageInsights({
    scope: { kind: "scenario", scenarioId },
    filters,
    threadsEnabled: false,
    breakdownEnabled: true,
  });
  // Analyze now; the status panel shows it to members only.
  const { rebuildBusy, handleRebuild } = useInsightsRebuild(
    rebuild,
    scenarioId,
  );
  const handleAnalyzeNow = useCallback(
    () => void handleRebuild({ settled: true }),
    [handleRebuild],
  );

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
    [drilldown],
  );

  const summary = useMemo(() => composeScenarioFindingsSummary(model), [model]);

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
  // The open goal's chain, and the goal it describes. Stored as a pair so an
  // answer for a goal the reader has since closed cannot paint the new one.
  const [chain, setChain] = useState<{
    goalId: string;
    stages: ScenarioGoalStages | null;
  } | null>(null);
  const handleChain = useCallback(
    (goalId: string, stages: ScenarioGoalStages | null) =>
      setChain({ goalId, stages }),
    [],
  );

  const chosenIndex =
    personaChoice === null
      ? -1
      : model.personas.findIndex((p) => p.name === personaChoice);
  const personaIndex = Math.min(
    chosenIndex >= 0 ? chosenIndex : model.defaultPersonaIndex,
    Math.max(0, model.personas.length - 1),
  );
  const persona = model.personas[personaIndex];

  /**
   * A goal's session list, scoped to the SAME population its row counted.
   *
   * A goal row lives under a persona and counts only that persona's sessions
   * on that goal, but a goal cluster spans every persona — "Creative requests"
   * shows up under two sentiments with a different count each. Paging by
   * cluster alone returns the union, so a 2-session goal opened a list of four
   * and the list contradicted the number that opened it.
   *
   * Carries the hide-synthetic policy too, for the reason it always did: a
   * rehearsal must not appear in a list describing real people.
   */
  const personaSentiment = model.personaSentiments[personaIndex];
  const sessionScope = useMemo(() => {
    if (!personaSentiment) {
      return { kind: "scenario", scenarioId, filters } as const;
    }
    const scoped: UsageFilterState = {
      preset: "all",
      chips: [{ kind: "dimension", key: "sentiment", value: personaSentiment }],
    };
    return {
      kind: "scenario",
      scenarioId,
      filters: withHideSynthetic(scoped),
    } as const;
  }, [scenarioId, filters, personaSentiment]);

  const expandedGoalId =
    expandedChoice && expandedChoice.personaName === persona?.name
      ? expandedChoice.goalId
      : null;
  // Only the goal that is open has a chain, and only while it is still the
  // goal that asked for it.
  const goalChain =
    chain && expandedGoalId && chain.goalId === expandedGoalId
      ? chain.stages
      : null;

  // The measured chain replaces the unmeasured placeholder on the open goal
  // and nothing else. Fields are named rather than spread so a field this
  // model does not have cannot ride along.
  //
  // `diagnosis` and `diagnosisStage` are carried even though nothing on this
  // surface renders them yet. Leaving them behind would keep a goal we just
  // measured asserting "Not measured per goal yet", which is the sort of stale
  // claim that survives right up until someone renders it.
  const personaInView = useMemo(() => {
    if (!persona || !goalChain || !expandedGoalId) return persona;
    return {
      ...persona,
      goals: persona.goals.map((goal) =>
        goal.runId === expandedGoalId
          ? {
              ...goal,
              stages: goalChain.stages,
              diagnosisStage: goalChain.diagnosisStage,
              diagnosis: goalChain.diagnosis,
              defaultStage: goalChain.defaultStage,
            }
          : goal,
      ),
    };
  }, [persona, goalChain, expandedGoalId]);

  const expandedGoal = personaInView?.goals.find(
    (goal) => goal.runId === expandedGoalId,
  );
  // A chain arriving after the panel opened moves the selection onto the break
  // it just found, which is where the reader was heading. It cannot move a
  // selection the reader made themselves — `stageChoice` wins whenever it
  // names this goal.
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
    // No sessions at all: the page's own empty panel when it hands one in.
    if (model.unanalyzedCount === 0 && emptyState) {
      return (
        <div className="h-full" data-testid="scenario-findings-empty">
          {emptyState}
        </div>
      );
    }
    // Why there is nothing to show yet, from the same summary the Session
    // flow reads (BB-196, and the 2026-09-22 report that "a few minutes" said
    // nothing). Gated on the breakdown having loaded, so the first
    // subscription cannot flash a reason at a study it does not describe.
    const status =
      model.unanalyzedCount === 0
        ? null
        : analysisStatus(breakdown?.analysis, Date.now());
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="scenario-findings-empty"
      >
        {model.unanalyzedCount === 0 ? (
          "No sessions in this study yet."
        ) : status ? (
          <AnalysisStatusPanel
            status={status}
            onAnalyzeNow={handleAnalyzeNow}
            busy={rebuildBusy}
            testId="scenario-findings-status"
          />
        ) : (
          "No session has been analyzed yet."
        )}
      </div>
    );
  }

  // `persona` is narrowed by the guard above; the memo cannot carry that.
  const shownPersona = personaInView ?? persona;

  return (
    <div className="w-full" data-testid="scenario-findings-tab">
      {expandedGoalId ? (
        <ScenarioGoalChain
          scenarioId={scenarioId}
          goalId={expandedGoalId}
          onResolved={handleChain}
        />
      ) : null}
      <FindingsSummaryCard
        sessionCount={model.sessionCount}
        summary={summary}
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
        persona={shownPersona}
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
        sessionScope={sessionScope}
      />
    </div>
  );
}
