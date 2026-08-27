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
}: {
  goal: GoalFindingsModel;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const stageMeta = JOURNEY_STAGES.find((s) => s.id === selectedStage)!;
  const stageModel = goal.stages[selectedStage];
  const evidencePanelId = `findings-stage-evidence-${goal.runId}`;

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
          className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-6"
          role="tablist"
          aria-label="User value chain stages"
        >
        {JOURNEY_STAGES.map((stage) => {
          const state = goal.stages[stage.id].state;
          const pressed = stage.id === selectedStage;
          return (
            <li key={stage.id}>
              <button
                type="button"
                role="tab"
                aria-pressed={pressed}
                aria-selected={pressed}
                aria-controls={evidencePanelId}
                onClick={() => onSelectStage(stage.id)}
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

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(250px,0.75fr)]">
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
                {stageModel.evidence.map((evidence, i) => (
                  <div
                    key={`${evidence.observation}-${i}`}
                    className="py-3.5 first:pt-4"
                    data-testid="findings-evidence-row"
                  >
                    <p className="text-sm font-semibold leading-relaxed text-zinc-50">
                      {evidence.observation}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-zinc-500">
                      {evidence.meta}
                    </p>
                    {evidence.sessionId && onOpenSession ? (
                      <button
                        type="button"
                        className="mt-2 text-[11px] font-medium text-orange-300 underline-offset-4 hover:text-orange-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                        onClick={() => onOpenSession(evidence.sessionId!)}
                        data-testid="findings-evidence-open-session"
                      >
                        Open source session →
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p
                className="mt-4 border-t border-white/10 pt-4 text-xs italic leading-relaxed text-zinc-400"
                data-testid="findings-empty-stage"
              >
                {EMPTY_STAGE_COPY}
              </p>
            )}
          </section>
          <aside
            className="rounded-xl border border-orange-200/20 bg-orange-300 p-4 text-zinc-950 sm:p-5"
            data-testid="findings-diagnosis"
          >
            <p className="font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-zinc-700/80">
              Journey read
            </p>
            <h4 className="mt-2 text-lg font-semibold tracking-[-0.02em]">
              {goal.diagnosis.title}
            </h4>
            <p className="mt-2 text-xs leading-relaxed text-zinc-800">
              {goal.diagnosis.detail}
            </p>
            <div className="mt-5 border-t border-zinc-950/15 pt-3 text-[10px] font-medium leading-relaxed text-zinc-700">
              Diagnosis starts at the earliest stage with a clear break.
            </div>
          </aside>
        </div>

        <div
          className="mt-4 grid gap-1.5 border-t border-white/10 pt-3 text-[10px] text-zinc-500 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Stage state legend"
          data-testid="findings-legend"
        >
          <div className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-emerald-400" />
            <span>Held · positive evidence</span>
          </div>
          <div className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-amber-400" />
            <span>Warning · friction or weak outcome</span>
          </div>
          <div className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-red-400" />
            <span>Failed · clear break</span>
          </div>
          <div className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-zinc-500" />
            <span>No finding · do not infer pass</span>
          </div>
        </div>
      </div>
    </article>
  );
}
