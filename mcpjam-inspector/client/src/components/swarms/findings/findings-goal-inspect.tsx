/**
 * The expanded panel under a goal row: the 6-stage user-value chain as
 * buttons, the selected stage's evidence, the "Journey read" diagnosis, and
 * the tone legend.
 *
 * The empty-stage copy is verbatim and load-bearing: a stage with no
 * evidence is UNKNOWN, and both the copy and the legend refuse to let it
 * read as a pass.
 */

import { cn } from "@/lib/utils";
import { JOURNEY_STAGES, type JourneyStageId } from "./journey-stages";
import type { GoalFindingsModel, StageState } from "./findings-derivation";

export const EMPTY_STAGE_COPY =
  "No finding landed on this stage. This is not evidence that the stage passed.";

const STAGE_BUTTON_CLASSES: Record<StageState, string> = {
  fail: "border-red-500/40 bg-red-500/15 text-red-800 dark:text-red-300",
  warn: "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300",
  ok: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  none: "border-white/15 bg-white/5 text-zinc-300",
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
}: {
  goal: GoalFindingsModel;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const stageMeta = JOURNEY_STAGES.find((s) => s.id === selectedStage)!;
  const stageModel = goal.stages[selectedStage];

  return (
    <div
      className="mb-2 rounded-2xl bg-zinc-900 p-5 text-zinc-50 dark:border dark:border-border/60"
      data-testid="findings-goal-inspect"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-lg font-semibold tracking-tight">
            Follow the user value chain
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Each stage answers a different question about whether the experience
            delivered.
          </p>
        </div>
        <p className="text-xs text-zinc-400">
          {goal.sessions} session{goal.sessions === 1 ? "" : "s"} · Select a
          stage
        </p>
      </div>

      <ol className="mb-4 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-6">
        {JOURNEY_STAGES.map((stage) => {
          const state = goal.stages[stage.id].state;
          const pressed = stage.id === selectedStage;
          return (
            <li key={stage.id}>
              <button
                type="button"
                aria-pressed={pressed}
                onClick={() => onSelectStage(stage.id)}
                className={cn(
                  "flex min-h-[6rem] w-full flex-col rounded-xl border p-3 text-left transition-shadow",
                  STAGE_BUTTON_CLASSES[state],
                  pressed && "ring-2 ring-violet-400"
                )}
                data-testid={`findings-stage-${stage.id}`}
                data-state={state}
              >
                <span className="font-mono text-[9px] tracking-[0.08em] opacity-70">
                  {stage.num}
                </span>
                <span className="mt-auto text-xs font-bold">{stage.title}</span>
                <span className="mt-1 font-mono text-[8px] font-bold uppercase tracking-[0.12em] opacity-70">
                  {stageStateLabel(state)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1.35fr)_minmax(230px,0.65fr)]">
        <div
          className="rounded-xl border border-white/15 bg-white/5 p-4"
          data-testid="findings-stage-evidence"
        >
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-400">
            What happened
          </p>
          <h4 className="mt-2 text-lg font-semibold">{stageMeta.title}</h4>
          <p className="mt-1.5 text-xs text-zinc-400">{stageMeta.question}</p>
          {stageModel.evidence.length > 0 ? (
            stageModel.evidence.map((evidence, i) => (
              <div
                key={`${evidence.observation}-${i}`}
                className="mt-4 border-t border-white/15 pt-3.5"
                data-testid="findings-evidence-row"
              >
                <p className="text-sm font-semibold text-zinc-50">
                  {evidence.observation}
                </p>
                <p className="mt-1 font-mono text-[10px] text-zinc-400">
                  {evidence.meta}
                </p>
                {evidence.sessionId && onOpenSession ? (
                  <button
                    type="button"
                    className="mt-1.5 text-[11px] font-medium text-violet-300 underline-offset-2 hover:underline"
                    onClick={() => onOpenSession(evidence.sessionId!)}
                    data-testid="findings-evidence-open-session"
                  >
                    Open a session
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <p
              className="mt-4 border-t border-white/15 pt-3.5 text-xs italic text-zinc-400"
              data-testid="findings-empty-stage"
            >
              {EMPTY_STAGE_COPY}
            </p>
          )}
        </div>
        <div
          className="rounded-xl bg-violet-300 p-4 text-zinc-900"
          data-testid="findings-diagnosis"
        >
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-violet-900/70">
            Journey read
          </p>
          <h4 className="mt-2 text-lg font-semibold">{goal.diagnosis.title}</h4>
          <p className="mt-1.5 text-xs text-zinc-800">
            {goal.diagnosis.detail}
          </p>
        </div>
      </div>

      <div
        className="mt-3 grid gap-1.5 text-[10px] text-zinc-400 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Stage state legend"
        data-testid="findings-legend"
      >
        <div className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2">
          <i className="size-2 rounded-full bg-emerald-400" />
          <span>Held · positive evidence</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2">
          <i className="size-2 rounded-full bg-amber-400" />
          <span>Warning · friction or weak outcome</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2">
          <i className="size-2 rounded-full bg-red-400" />
          <span>Failed · clear break</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2">
          <i className="size-2 rounded-full bg-zinc-500" />
          <span>No finding · do not infer pass</span>
        </div>
      </div>
    </div>
  );
}
