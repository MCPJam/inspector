import { useEffect, useMemo, useState } from "react";
import { Check, SquareCheck } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  readScenarioTaskChecks,
  scenarioTasksRemainingLabel,
  writeScenarioTaskChecks,
} from "@/lib/scenario-tasks";
import type { ScenarioTaskItem } from "@/types/chatUi";
import { cn } from "@/lib/utils";

/**
 * The tester's "what to try" list, in their own session header beside Copy
 * link (BB-176).
 *
 * **Always available, never in the way.** It is a header control the tester
 * opens when they want it — not a sidebar that eats the chat, not a wizard
 * that walks them through the study, and not a gate on the composer. They work
 * the list in any order, or ignore it.
 *
 * **Check state is theirs.** Kept per tab (see `scenario-tasks`) and sent
 * nowhere: the creator learns what happened from Sessions, and a
 * self-reported checkmark would be weaker evidence dressed up as data.
 * Nothing here can be read as "this tester failed task 3".
 *
 * **Hidden when the study has no tasks.** The caller decides that by not
 * rendering this; an empty checklist behind an "All checked" button would be
 * a control that only ever says nothing.
 *
 * **Optional, and says so before it opens.** The button keeps the short name
 * "What to try"; the count beside it is worded as checkbox state
 * ("2 unchecked") with a checkbox glyph, so it cannot be read as credits or a
 * limit. The popover heading spells the same thing out: "Optional things to
 * try".
 */
export function ScenarioTaskChecklist({
  scenarioId,
  tasks,
}: {
  scenarioId: string;
  tasks: readonly ScenarioTaskItem[];
}) {
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    readScenarioTaskChecks(scenarioId),
  );

  // Reload on a scenario switch: a stored set from another study would tick
  // boxes whose ids happen to collide.
  useEffect(() => {
    setCheckedIds(readScenarioTaskChecks(scenarioId));
  }, [scenarioId]);

  const checked = useMemo(() => new Set(checkedIds), [checkedIds]);

  // Counted against the tasks the study CURRENTLY has, not against everything
  // ever stored: a creator who removes a task must not leave the tester on
  // "4 unchecked" out of three.
  const completed = tasks.reduce(
    (total, task) => (checked.has(task.id) ? total + 1 : total),
    0,
  );
  const remainingLabel = scenarioTasksRemainingLabel(tasks.length, completed);
  const allDone = completed >= tasks.length;

  const toggle = (taskId: string) => {
    // Computed OUTSIDE the updater, and the write with it. React may invoke a
    // state updater more than once for a single call (StrictMode does it on
    // purpose), and a toggle that persists from inside the updater would then
    // save the SECOND toggle — undoing the tester's click in storage while the
    // rendered checkbox showed it applied.
    const next = checkedIds.includes(taskId)
      ? checkedIds.filter((id) => id !== taskId)
      : [...checkedIds, taskId];
    setCheckedIds(next);
    writeScenarioTaskChecks(scenarioId, next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* ONE surface. The count is a sibling span inside the button, not a
            badge with its own background sitting in it — a pill inside a pill
            reads as two controls, and only one of them is clickable. */}
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          data-testid="scenario-tasks-trigger"
          aria-label={`Optional things to try — ${remainingLabel}`}
        >
          <span className="font-medium">What to try</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs",
              allDone ? "text-muted-foreground" : "font-semibold text-primary",
            )}
            // Ticking an item changes this number, and the tester is looking
            // at the popover row they just clicked rather than at the header.
            // Polite, not assertive: it is progress, not an alert.
            aria-live="polite"
            data-testid="scenario-tasks-remaining"
          >
            <SquareCheck aria-hidden className="size-3.5" />
            {remainingLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-70 p-4">
        <p className="text-sm font-semibold text-foreground">
          Optional things to try
        </p>
        <ul className="mt-2 flex flex-col gap-0.5">
          {tasks.map((task) => {
            const isChecked = checked.has(task.id);
            return (
              <li key={task.id}>
                {/* The whole row is the control: a 20px checkbox is a small
                    target, and the label is what the tester is reading. */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isChecked}
                  onClick={() => toggle(task.id)}
                  data-testid={`scenario-tasks-item-${task.id}`}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors",
                    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2",
                    "focus-visible:ring-ring",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-px flex size-5 shrink-0 items-center justify-center rounded-sm border",
                      isChecked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                  >
                    {isChecked ? (
                      <Check className="size-3" strokeWidth={3} />
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-[13px] leading-snug",
                        isChecked
                          ? "font-medium text-muted-foreground line-through"
                          : "text-foreground",
                      )}
                    >
                      {task.title}
                    </span>
                    {task.hint ? (
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                        {task.hint}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/* Says the list is not an exam, at the one moment a tester might
            assume it was. */}
        <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
          Try any, in any order. This checklist is only for you.
        </p>
      </PopoverContent>
    </Popover>
  );
}
