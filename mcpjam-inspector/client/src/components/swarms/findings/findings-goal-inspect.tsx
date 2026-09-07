/**
 * The expanded panel under a goal row: the 6-stage user-value chain as a
 * two-lane swimlane (client / agent, server) and the selected stage's
 * evidence.
 *
 * Layout follows `docs/uvc-client-server-swimlane.md`: time runs top to
 * bottom so the chain never reads out of order, and each stage sits in the
 * lane that should look next. Stage fills stay fail / warn / held —
 * selection is a white ring, and the lanes carry no color of their own.
 *
 * The empty-stage copy is verbatim and load-bearing: a stage with no
 * evidence is UNKNOWN and must not read as a pass. Nothing may sit under it
 * either — a session list there is read as "here is what got through".
 *
 * Where sessions ARE listed, the scope comes off the evidence row
 * (`EvidenceSessions`), never off the goal: a goal-scoped list shows the same
 * rows on all six stages and contradicts the denominator beside it.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  JOURNEY_LANES,
  JOURNEY_STAGES,
  journeyLaneLabel,
  journeyStageCrossesWire,
  type JourneyLaneId,
  type JourneyStageId,
} from "./journey-stages";
import {
  evidenceSampleNote,
  type GoalFindingsModel,
  type StageState,
} from "./findings-derivation";
import { FindingsEvidenceSessions } from "./findings-evidence-sessions";

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

const LANE_COLUMN_CLASSES: Record<JourneyLaneId, string> = {
  client: "sm:col-start-1",
  server: "sm:col-start-2",
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
  /** When set, evidence rows list the sessions they implicate, for click-through. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const stageMeta = JOURNEY_STAGES.find((s) => s.id === selectedStage)!;
  const stageModel = goal.stages[selectedStage];
  const evidencePanelId = `findings-stage-evidence-${goal.runId}`;
  // Open the first row that HAS sessions. A row whose evidence names none
  // (launch outcomes, a clean pass) is never the one we expand into.
  const firstListable = stageModel.evidence.findIndex(
    (evidence) => evidence.sessions.kind !== "none"
  );
  const [openEvidence, setOpenEvidence] = useState(
    onOpenSession ? firstListable : -1
  );

  useEffect(() => {
    setOpenEvidence(onOpenSession ? firstListable : -1);
  }, [selectedStage, goal.runId, onOpenSession, firstListable]);

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
              Time runs top to bottom. Each stage sits in the lane that should
              look next.
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
        <div className="relative" data-testid="findings-stage-swimlane">
          {/* The wire. Stages sit either side of it, and the two hand-off
              rows are the only things that cross it. */}
          <span
            className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-0 -translate-x-1/2 border-l-2 border-dotted border-white/25 sm:block"
            data-testid="findings-lane-boundary"
            aria-hidden
          />

          <div
            className="hidden border-b border-white/10 pb-2 sm:grid sm:grid-cols-2 sm:gap-x-3"
            aria-hidden
          >
            {JOURNEY_LANES.map((lane) => (
              <p
                key={lane.id}
                className="px-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-200"
              >
                {lane.label}
              </p>
            ))}
          </div>

          <ol
            ref={stageListRef}
            className="list-none space-y-1.5 p-0 pt-2"
            role="tablist"
            aria-label="User value chain stages"
          >
            {JOURNEY_STAGES.map((stage, stageIndex) => {
              const state = goal.stages[stage.id].state;
              const pressed = stage.id === selectedStage;
              return (
                <Fragment key={stage.id}>
                  {journeyStageCrossesWire(stage.id) ? (
                    <li
                      className="flex items-center gap-2 py-1"
                      role="presentation"
                      data-testid="findings-lane-crossing"
                      data-to={stage.lane}
                      aria-hidden
                    >
                      {stage.lane === "client" ? (
                        <ArrowLeft className="size-3 shrink-0 text-zinc-500" />
                      ) : null}
                      <span className="h-px flex-1 bg-white/20" />
                      {stage.lane === "server" ? (
                        <ArrowRight className="size-3 shrink-0 text-zinc-500" />
                      ) : null}
                    </li>
                  ) : null}
                  <li className="grid grid-cols-1 sm:grid-cols-2 sm:gap-x-3">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={pressed}
                      aria-controls={evidencePanelId}
                      tabIndex={pressed ? 0 : -1}
                      onClick={() => onSelectStage(stage.id)}
                      onKeyDown={(event) =>
                        handleStageKeyDown(event, stageIndex)
                      }
                      className={cn(
                        "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] duration-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
                        LANE_COLUMN_CLASSES[stage.lane],
                        STAGE_BUTTON_CLASSES[state],
                        pressed &&
                          "ring-2 ring-white ring-offset-2 ring-offset-zinc-950"
                      )}
                      data-testid={`findings-stage-${stage.id}`}
                      data-state={state}
                      data-lane={stage.lane}
                    >
                      <span className="w-5 shrink-0 font-mono text-[11px] font-semibold tabular-nums tracking-tight text-current">
                        {stage.num}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-bold tracking-[-0.01em]">
                          {stage.title}
                        </span>
                        <span className="mt-0.5 block font-mono text-[8px] font-bold uppercase tracking-[0.12em] opacity-60">
                          {stageStateLabel(state)}
                        </span>
                      </span>
                      {/* The lane headers carry this above `sm`; below it the
                          rows stack into one column and each states its own. */}
                      <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.12em] opacity-50 sm:sr-only">
                        {journeyLaneLabel(stage.lane)}
                      </span>
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          STAGE_DOT_CLASSES[state]
                        )}
                      />
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </div>

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
                  // Only evidence that names sessions gets a disclosure. The
                  // rest print their denominator flat — there is nothing
                  // underneath to reveal. Held as the narrowed scope rather
                  // than a boolean so the child cannot be handed `none`.
                  const scope =
                    onOpenSession && evidence.sessions.kind !== "none"
                      ? evidence.sessions
                      : null;
                  const sampleNote = evidenceSampleNote(evidence.sessions);
                  return (
                    <div
                      key={`${evidence.observation}-${i}`}
                      className="py-3.5 first:pt-4"
                      data-testid="findings-evidence-row"
                    >
                      <p className="text-sm font-semibold leading-relaxed text-zinc-50">
                        {evidence.observation}
                      </p>
                      {scope ? (
                        <button
                          type="button"
                          className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                          aria-expanded={expanded}
                          onClick={() => setOpenEvidence(expanded ? -1 : i)}
                          data-testid="findings-evidence-sessions-toggle"
                        >
                          {sampleNote
                            ? `${evidence.meta} · ${sampleNote}`
                            : evidence.meta}
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
                      {scope && expanded && onOpenSession ? (
                        <FindingsEvidenceSessions
                          key={`${goal.runId}-${selectedStage}-${i}`}
                          runId={goal.runId}
                          sessions={scope}
                          onOpenSession={onOpenSession}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* No session list here, deliberately. The stage is UNKNOWN, and
                 the goal's sessions are not evidence about it — offering them
                 under this sentence is read as "here is what got through",
                 which is the one inference the copy exists to refuse. */
              <div className="mt-4 border-t border-white/10 pt-4">
                <p
                  className="text-xs italic leading-relaxed text-zinc-400"
                  data-testid="findings-empty-stage"
                >
                  {EMPTY_STAGE_COPY}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}
