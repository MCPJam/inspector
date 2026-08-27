/**
 * The selected persona's panel: identity aside (avatar, name, meta, issue
 * one-liner, sentiment pill + disclaimer) beside the "Goals they tried"
 * accordion. Expanding a goal mounts `FindingsGoalInspect` inline.
 */

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { SentimentPill } from "./findings-sentiment-pill";
import { FindingsGoalInspect } from "./findings-goal-inspect";
import type { JourneyStageId } from "./journey-stages";
import type { PersonaFindingsModel } from "./findings-derivation";

export function FindingsPersonaCard({
  persona,
  selectedTabId,
  expandedGoalRunId,
  onToggleGoal,
  selectedStage,
  onSelectStage,
  onOpenSession,
}: {
  persona: PersonaFindingsModel;
  /** id of the tab that labels this panel (aria wiring). */
  selectedTabId: string;
  expandedGoalRunId: string | null;
  onToggleGoal: (runId: string) => void;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <section
      id="findings-persona-panel"
      role="tabpanel"
      aria-labelledby={selectedTabId}
      className="grid overflow-hidden rounded-xl border border-border bg-card shadow-sm md:grid-cols-[minmax(224px,0.7fr)_minmax(0,1.6fr)]"
      data-testid="findings-persona-card"
    >
      <aside className="border-b border-border bg-muted p-5 md:border-b-0 md:border-r">
        <div className="flex items-start gap-3">
          <PersonaPixelAvatar
            seed={persona.avatarSeed}
            shapeIndex={persona.avatarShape ?? null}
            paletteIndex={persona.avatarPalette ?? null}
            size="lg"
          />
          <div className="min-w-0">
            <h3 className="text-[18px] font-semibold leading-tight tracking-tight text-foreground">
              {persona.name}
            </h3>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="findings-persona-meta"
            >
              {persona.role ? `${persona.role} · ` : ""}
              {persona.sessionsAuthored} session
              {persona.sessionsAuthored === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <p
          className="mt-[18px] border-t border-border pt-4 text-[15px] leading-snug text-foreground"
          data-testid="findings-persona-issue"
        >
          {persona.issue}
        </p>
        <p className="mt-3.5 text-[11px] leading-relaxed text-muted-foreground">
          <SentimentPill sentiment={persona.sentiment} className="mr-1.5" />
          is the inferred feeling attached to the experience, not a score for
          the person.
        </p>
      </aside>

      <div className="px-5 pb-5 pt-4">
        <p className="pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Goals they tried
        </p>
        {persona.goals.map((goal) => {
          const expanded = goal.runId === expandedGoalRunId;
          return (
            <div key={goal.runId}>
              <button
                type="button"
                aria-expanded={expanded}
                {...(expanded
                  ? { "aria-controls": `findings-goal-${goal.runId}` }
                  : {})}
                onClick={() => onToggleGoal(goal.runId)}
                className="flex w-full items-center justify-between gap-4 border-t border-border px-1 py-3.5 text-left"
                data-testid="findings-goal-row"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold leading-snug text-foreground">
                    {goal.title}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    {goal.sessions} session{goal.sessions === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <SentimentPill sentiment={goal.sentiment} />
                  <ChevronDown
                    className={cn(
                      "size-4 text-muted-foreground transition-transform",
                      expanded && "rotate-180"
                    )}
                  />
                </span>
              </button>
              {expanded ? (
                <div id={`findings-goal-${goal.runId}`}>
                  <FindingsGoalInspect
                    goal={goal}
                    selectedStage={selectedStage}
                    onSelectStage={onSelectStage}
                    onOpenSession={onOpenSession}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
