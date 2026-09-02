/**
 * The expanded panel under a goal row: the 6-stage user-value chain as
 * buttons and the selected stage's evidence.
 *
 * The empty-stage copy is verbatim and load-bearing: a stage with no
 * evidence is UNKNOWN and must not read as a pass.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { JOURNEY_STAGES, type JourneyStageId } from "./journey-stages";
import type { GoalFindingsModel, StageState } from "./findings-derivation";
import { FindingsGoalSessions } from "./findings-goal-sessions";

export const EMPTY_STAGE_COPY =
  "No finding landed on this stage. This is not evidence that the stage passed.";

const STAGE_BUTTON_CLASSES: Record<StageState, string> = {
  fail: "border-red-400/60 bg-red-500/20 text-red-50",
  warn: "border-amber-300/60 bg-amber-400/15 text-amber-50",
  ok: "border-emerald-300/50 bg-emerald-400/15 text-emerald-50",
  none: "border-white/15 bg-white/[0.045] text-zinc-300",
};

const STAGE_DOT_CLASSES: Record<StageState, string> = {
  fail: "bg-red-300",
  warn: "bg-amber-300",
  ok: "bg-emerald-300",
  none: "bg-zinc-500",
};

function stageStateLabel(state: StageState): string {
  if (state === "fail") return "failed";
  if (state === "warn") return "warning";
  if (state === "ok") return "held";
  return "no finding";
}

export function FindingsGoalInspect({
  goal,
  selectedStage,
  onSelectStage,
  onOpenSession,
  projectId,
}: {
  goal: GoalFindingsModel;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
  onOpenSession?: (sessionId: string) => void;
  /** When set, the inspect panel pages this goal's sessions for click-through. */
  projectId?: string;
}) {
  const stageMeta = JOURNEY_STAGES.find((s) => s.id === selectedStage)!;
  const stageModel = goal.stages[selectedStage];
  const evidencePanelId = `findings-stage-evidence-${goal.runId}`;
  const canListSessions = Boolean(projectId && onOpenSession);
  const [openEvidence, setOpenEvidence] = useState(canListSessions ? 0 : -1);

  useEffect(() => {
    setOpenEvidence(canListSessions ? 0 : -1);
  }, [selectedStage, goal.runId, canListSessions]);

  // Roving tabindex: one tab stop for the whole strip, arrows move between
  // stages — same contract as `FindingsPersonaTabs`.
  const stageListRef = useRef<HTMLOListElement>(null);
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
    <article
      className="mb-2 overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950 text-zinc-50 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.8)]"
      data-testid="findings-goal-inspect"
    >
      <header className="border-b border-white/10 px-5 pb-4 pt-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-orange-300/80">
              Journey diagnostic
            </p>
            <h3 className="mt-1.5 text-lg font-semibold tracking-[-0.02em]">
              Follow the user value chain
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">
            Each stage answers a different question about whether the experience
            delivered.
            </p>
          </div>
          <div className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] text-zinc-400">
            {goal.sessions} session{goal.sessions === 1 ? "" : "s"}
            <span className="mx-1.5 text-zinc-600">·</span>
            select a stage
          </div>
        </div>
      </header>

      <div className="px-5 py-4 sm:px-6">
        <ol
          ref={stageListRef}
          className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-6"
          role="tablist"
          aria-label="User value chain stages"
        >
        {JOURNEY_STAGES.map((stage, stageIndex) => {
          const state = goal.stages[stage.id].state;
          const pressed = stage.id === selectedStage;
          return (
            <li key={stage.id}>
              <button
                type="button"
                role="tab"
                aria-selected={pressed}
                aria-controls={evidencePanelId}
                tabIndex={pressed ? 0 : -1}
                onClick={() => onSelectStage(stage.id)}
                onKeyDown={(event) => handleStageKeyDown(event, stageIndex)}
                className={cn(
                  "group flex min-h-[6.5rem] w-full flex-col rounded-xl border p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
                  STAGE_BUTTON_CLASSES[state],
                  pressed &&
                    "border-orange-300/80 bg-orange-300/15 shadow-[0_0_0_2px_rgba(253,186,116,0.18)]"
                )}
                data-testid={`findings-stage-${stage.id}`}
                data-state={state}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] tracking-[0.08em] opacity-60">
                    {stage.num}
                  </span>
                  <span className={cn("size-1.5 rounded-full", STAGE_DOT_CLASSES[state])} />
                </span>
                <span className="mt-auto text-xs font-bold tracking-[-0.01em]">
                  {stage.title}
                </span>
                <span className="mt-1 font-mono text-[8px] font-bold uppercase tracking-[0.12em] opacity-60">
                  {stageStateLabel(state)}
                </span>
              </button>
            </li>
          );
        })}
        </ol>

        <div className="mt-3">
          <section
            className="rounded-xl border border-white/12 bg-white/[0.045] p-4 sm:p-5"
            data-testid="findings-stage-evidence"
            id={evidencePanelId}
            role="tabpanel"
            aria-label={`${stageMeta.title} evidence`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-orange-300/80">
                  What happened
                </p>
                <h4 className="mt-2 text-lg font-semibold tracking-[-0.02em]">
                  {stageMeta.title}
                </h4>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
                {stageStateLabel(stageModel.state)}
              </span>
            </div>
            <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-zinc-400">
              {stageMeta.question}
            </p>
            {stageModel.evidence.length > 0 ? (
              <div className="mt-4 divide-y divide-white/10 border-t border-white/10">
                {stageModel.evidence.map((evidence, i) => {
                  const expanded = openEvidence === i;
                  return (
                    <div
                      key={`${evidence.observation}-${i}`}
                      className="py-3.5 first:pt-4"
                      data-testid="findings-evidence-row"
                    >
                      <p className="text-sm font-semibold leading-relaxed text-zinc-50">
                        {evidence.observation}
                      </p>
                      {canListSessions ? (
                        <button
                          type="button"
                          className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                          aria-expanded={expanded}
                          onClick={() =>
                            setOpenEvidence(expanded ? -1 : i)
                          }
                          data-testid="findings-evidence-sessions-toggle"
                        >
                          {evidence.meta}
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 text-zinc-500 transition-transform",
                              expanded && "rotate-180"
                            )}
                            aria-hidden
                          />
                        </button>
                      ) : (
                        <p className="mt-1 font-mono text-[10px] text-zinc-500">
                          {evidence.meta}
                        </p>
                      )}
                      {evidence.sessionId && onOpenSession && !canListSessions ? (
                        <button
                          type="button"
                          className="mt-2 text-[11px] font-medium text-orange-300 underline-offset-4 hover:text-orange-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                          onClick={() => onOpenSession(evidence.sessionId!)}
                          data-testid="findings-evidence-open-session"
                        >
                          Open source session →
                        </button>
                      ) : null}
                      {canListSessions && expanded && projectId && onOpenSession ? (
                        <FindingsGoalSessions
                          key={goal.runId}
                          projectId={projectId}
                          runId={goal.runId}
                          expectedCount={goal.sessions}
                          onOpenSession={onOpenSession}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 border-t border-white/10 pt-4">
                <p
                  className="text-xs italic leading-relaxed text-zinc-400"
                  data-testid="findings-empty-stage"
                >
                  {EMPTY_STAGE_COPY}
                </p>
                {canListSessions && projectId && onOpenSession ? (
                  <>
                    <button
                      type="button"
                      className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                      aria-expanded={openEvidence === 0}
                      onClick={() =>
                        setOpenEvidence(openEvidence === 0 ? -1 : 0)
                      }
                      data-testid="findings-evidence-sessions-toggle"
                    >
                      {goal.sessions} session{goal.sessions === 1 ? "" : "s"}
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 text-zinc-500 transition-transform",
                          openEvidence === 0 && "rotate-180"
                        )}
                        aria-hidden
                      />
                    </button>
                    {openEvidence === 0 ? (
                      <FindingsGoalSessions
                        key={goal.runId}
                        projectId={projectId}
                        runId={goal.runId}
                        expectedCount={goal.sessions}
                        onOpenSession={onOpenSession}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}
