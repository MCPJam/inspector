/**
 * The expanded panel under a goal row: the 6-stage user-value chain as a
 * rail, and the selected stage's evidence beside it.
 *
 * Same shell as the evals trial scorecard — ordinal, name, tone on the
 * dot; state word on the open heading — so the two surfaces do not tell
 * the same story in two visual languages. The children stay findings:
 * observations, population lines, session click-through. There are no
 * EXPECTED / ACTUAL rows here.
 *
 * The empty-stage copy is verbatim and load-bearing: a stage with no
 * evidence is UNKNOWN and must not read as a pass.
 */

import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CHAIN_STAGE_BY_JOURNEY,
  JOURNEY_STAGES,
  type JourneyStageId,
} from "./journey-stages";
import type { GoalFindingsModel, StageState } from "./findings-derivation";
import {
  FindingsGoalSessions,
  type FindingsSessionScope,
  type FindingsStageNarrowing,
} from "./findings-goal-sessions";
import { FindingText } from "@/components/shared/actionable-insights/finding-text";

export const EMPTY_STAGE_COPY =
  "No finding landed on this stage. This is not evidence that the stage passed.";

/**
 * Tone on the rail dot only. The state WORD lives on the open heading,
 * matching the scorecard rail: nothing states the same verdict twice.
 */
const STAGE_DOT_CLASS: Record<StageState, string> = {
  fail: "text-destructive",
  warn: "text-warning",
  ok: "text-success",
  none: "text-muted-foreground",
};

const STAGE_CHIP_CLASS: Record<StageState, string> = {
  fail: "bg-destructive/10 text-destructive",
  warn: "bg-warning/15 text-warning",
  ok: "bg-success/15 text-foreground",
  none: "bg-muted text-muted-foreground",
};

function stageStateLabel(state: StageState): string {
  if (state === "fail") return "Failed";
  if (state === "warn") return "Warning";
  if (state === "ok") return "Pass";
  return "No finding";
}

export function FindingsGoalInspect({
  goal,
  selectedStage,
  onSelectStage,
  onOpenSession,
  sessionScope,
}: {
  goal: GoalFindingsModel;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
  onOpenSession?: (sessionId: string) => void;
  /**
   * When set, the inspect panel pages this goal's sessions for click-through.
   * The surface owns how a goal is keyed, so it hands the scope in rather than
   * this panel assuming a swarm.
   */
  sessionScope?: FindingsSessionScope;
}) {
  const stageMeta = JOURNEY_STAGES.find((s) => s.id === selectedStage)!;
  const stageModel = goal.stages[selectedStage];

  /**
   * The sessions THIS stage's row is about.
   *
   * A failing or uneasy stage is about its failures; a passing one about its
   * passes. A stage with no verdict is about nothing — narrowing there would
   * empty a list whose own copy says the stage was never graded, so it stays
   * `null` and the goal's whole list remains.
   *
   * Scenario scope only, because only the scenario reader takes chips: a swarm
   * goal pages by run id and the backend ignores filters entirely. Computing a
   * narrowing there would build a chip nobody sends AND churn `sessionsKey`
   * per stage, so clicking through the six tabs on Swarms would flash
   * "Loading sessions…" and repaint the identical unnarrowed rows — which a
   * reader takes as "these are the 2 sessions", when it is all 5.
   */
  const stageNarrowing: FindingsStageNarrowing | null =
    stageModel.state === "none" || sessionScope?.kind !== "scenario"
      ? null
      : {
          chainStage: CHAIN_STAGE_BY_JOURNEY[selectedStage],
          state: stageModel.state === "ok" ? "passed" : "failed",
        };
  // Everything the list's contents depend on: the goal, the narrowing, and
  // the SCOPE, which carries the caller's filters. Without the scope here, a
  // retained `before` cursor and the pages already fetched outlive the query
  // that produced them — the previous cohort's rows under a header counting
  // the new one.
  //
  // Not reachable from the User Testing tab as it stands: its filters are a
  // constant memo, and the one part that does vary (the persona) already
  // closes the expansion. This is the component's own boundary being correct
  // rather than a live defect closed, and it costs one interpolation.
  const sessionsKey = `${goal.runId}:${
    stageNarrowing
      ? `${stageNarrowing.chainStage}:${stageNarrowing.state}`
      : "all"
  }:${JSON.stringify(sessionScope ?? null)}`;
  /**
   * The stage's session list, wrapped and keyed ONCE for both mount sites.
   *
   * KEYED for two things the page-replacing effect does not cover. `before`
   * and the pages already fetched are component state, so after a "Load more"
   * they survive a change of narrowing and the reader sees the previous
   * stage's extra pages under this stage's header. And `ErrorBoundary` has no
   * `resetKeys`: once it has caught, it stays in its fallback for the life of
   * the element, so an unkeyed one would swallow the list for every LATER
   * stage after a single failure.
   *
   * BOUNDED because `useGoalOutcomeDrilldown` throws, and a backend that does
   * not know the `stage` chip would otherwise blank the whole Findings tab
   * through the boundary in `UserTestingScenarioDetail`. This keeps the
   * failure to the one list it belongs to, and the reader does not have to
   * click a stage to reach it.
   */
  const stageSessions =
    sessionScope && onOpenSession ? (
      <ErrorBoundary
        key={sessionsKey}
        name="findings-goal-sessions"
        fallback={
          // NOT `null`. The reader is looking at a stage row that names a
          // number of sessions, and a list that vanished without saying so
          // reads as "none" — a different claim. `isExpectedError` is left
          // unset on purpose: what this catches is a rollback, and a rollback
          // should page someone.
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="findings-goal-sessions-error"
          >
            Could not load this stage&rsquo;s sessions.
          </p>
        }
      >
        <FindingsGoalSessions
          scope={sessionScope}
          goalId={goal.runId}
          expectedCount={goal.sessions}
          stage={stageNarrowing}
          onOpenSession={onOpenSession}
        />
      </ErrorBoundary>
    ) : null;
  const evidencePanelId = `findings-stage-evidence-${goal.runId}`;
  const canListSessions = Boolean(sessionScope && onOpenSession);
  const [openEvidence, setOpenEvidence] = useState(canListSessions ? 0 : -1);

  // No sessions means no control at all, and a lone session under a lone
  // finding is a link rather than something to expand.
  //
  // Several findings earn the toggle even over ONE session: the list renders
  // under a single row, so without it row 0 keeps the only way in and every
  // other finding — a second failed rubric check over that same session — is
  // text with nothing to click. The empty-stage footer below is unaffected:
  // it only renders when there is no evidence at all.
  const sessionCount = goal.sessions;
  const canShowSessions = canListSessions && sessionCount > 0;
  const sessionsAreExpandable =
    canShowSessions && (sessionCount > 1 || stageModel.evidence.length > 1);

  useEffect(() => {
    setOpenEvidence(canListSessions ? 0 : -1);
  }, [selectedStage, goal.runId, canListSessions]);

  // Roving tabindex: one tab stop for the whole rail, arrows move between
  // stages — same contract as `FindingsPersonaTabs`.
  const stageListRef = useRef<HTMLElement>(null);
  const handleStageKeyDown = (event: React.KeyboardEvent, index: number) => {
    const count = JOURNEY_STAGES.length;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % count;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + count) % count;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    onSelectStage(JOURNEY_STAGES[next]!.id);
    stageListRef.current
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")
      [next]?.focus();
  };

  return (
    <article className="mb-2 px-1 py-2" data-testid="findings-goal-inspect">
      <div className="grid gap-6 sm:grid-cols-[170px_minmax(0,1fr)]">
        <nav
          ref={stageListRef}
          className="space-y-1"
          role="tablist"
          aria-label="User value chain stages"
        >
          {JOURNEY_STAGES.map((stage, stageIndex) => {
            const state = goal.stages[stage.id].state;
            const pressed = stage.id === selectedStage;
            return (
              <button
                key={stage.id}
                type="button"
                role="tab"
                aria-label={`${stage.num} ${stage.title}: ${stageStateLabel(state)}`}
                aria-selected={pressed}
                aria-controls={evidencePanelId}
                tabIndex={pressed ? 0 : -1}
                onClick={() => onSelectStage(stage.id)}
                onKeyDown={(event) => handleStageKeyDown(event, stageIndex)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  pressed && "bg-muted font-semibold",
                )}
                data-testid={`findings-stage-${stage.id}`}
                data-state={state}
              >
                <span className={STAGE_DOT_CLASS[state]} aria-hidden="true">
                  ●
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {stage.num}
                </span>
                {stage.title}
              </button>
            );
          })}
        </nav>

        <section
          className="min-w-0 space-y-3"
          data-testid="findings-stage-evidence"
          id={evidencePanelId}
          role="tabpanel"
          aria-label={`${stageMeta.title} evidence`}
        >
          <div className="space-y-1">
            <h4 className="flex items-center gap-2 text-base font-semibold text-foreground">
              {stageMeta.title}
              <span
                className={cn(
                  "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  STAGE_CHIP_CLASS[stageModel.state],
                )}
              >
                {stageStateLabel(stageModel.state)}
              </span>
            </h4>
            <p className="text-sm text-muted-foreground">{stageMeta.question}</p>
          </div>

          {stageModel.evidence.length > 0 ? (
            <div className="divide-y divide-border/60 border-t border-border/60">
              {stageModel.evidence.map((evidence, i) => {
                const expanded = openEvidence === i;
                return (
                  <div
                    key={`${evidence.observation}-${i}`}
                    className="py-3 first:pt-3"
                    data-testid="findings-evidence-row"
                  >
                    <p className="text-sm leading-relaxed text-foreground">
                      <FindingText text={evidence.observation} />
                    </p>
                    {sessionsAreExpandable ? (
                      <button
                        type="button"
                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={expanded}
                        onClick={() => setOpenEvidence(expanded ? -1 : i)}
                        data-testid="findings-evidence-sessions-toggle"
                      >
                        {evidence.meta}
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground transition-transform",
                            expanded && "rotate-180",
                          )}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {evidence.meta}
                      </p>
                    )}
                    {evidence.sessionId &&
                    onOpenSession &&
                    !canListSessions ? (
                      <button
                        type="button"
                        className="mt-2 text-[11px] font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onOpenSession(evidence.sessionId!)}
                        data-testid="findings-evidence-open-session"
                      >
                        Open source session →
                      </button>
                    ) : null}
                    {canShowSessions &&
                    sessionScope &&
                    onOpenSession &&
                    (sessionsAreExpandable ? expanded : i === 0)
                      ? stageSessions
                      : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="border-t border-border/60 pt-3">
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                data-testid="findings-empty-stage"
              >
                {EMPTY_STAGE_COPY}
              </p>
              {canShowSessions && sessionScope && onOpenSession ? (
                <>
                  {sessionsAreExpandable ? (
                    <button
                      type="button"
                      className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={openEvidence === 0}
                      onClick={() =>
                        setOpenEvidence(openEvidence === 0 ? -1 : 0)
                      }
                      data-testid="findings-evidence-sessions-toggle"
                    >
                      {goal.sessions} sessions
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 text-muted-foreground transition-transform",
                          openEvidence === 0 && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </button>
                  ) : null}
                  {(sessionsAreExpandable ? openEvidence === 0 : true)
                    ? stageSessions
                    : null}
                </>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </article>
  );
}
