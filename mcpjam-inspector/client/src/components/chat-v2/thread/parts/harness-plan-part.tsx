import { Check, Circle, CircleDot } from "lucide-react";
import { cn } from "@/lib/chat-utils";
import type { HarnessPlanInfo } from "@/shared/harness-session";

/**
 * The agent's own plan for the turn, as a checklist (Codex's `update_plan`).
 * The part is replaced in place on every update, so this always shows the
 * latest plan where it first appeared in the reply.
 */
export function HarnessPlanPart({ plan }: { plan: HarnessPlanInfo }) {
  if (plan.steps.length === 0) return null;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <div
      className="rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-xs"
      data-testid="harness-plan"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="font-medium text-foreground">Plan</span>
        <span>
          {done} of {plan.steps.length} done
        </span>
      </div>
      {plan.explanation && (
        <p className="mt-1 text-muted-foreground">{plan.explanation}</p>
      )}
      <ol className="mt-2 space-y-1">
        {plan.steps.map((step, index) => (
          <li
            key={`${index}-${step.step}`}
            className="flex items-start gap-2"
            data-status={step.status}
          >
            <span className="mt-[3px] inline-flex shrink-0">
              {step.status === "completed" ? (
                <Check
                  className="h-3 w-3 text-muted-foreground"
                  aria-label="Done"
                />
              ) : step.status === "inProgress" ? (
                // Not a spinner: a plan the turn left mid-step stays honest.
                <CircleDot
                  className="h-3 w-3 text-foreground"
                  aria-label="In progress"
                />
              ) : (
                <Circle
                  className="h-3 w-3 text-muted-foreground/60"
                  aria-label="To do"
                />
              )}
            </span>
            <span
              className={cn(
                "min-w-0",
                step.status === "completed"
                  ? "text-muted-foreground line-through decoration-border"
                  : step.status === "inProgress"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {step.step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
