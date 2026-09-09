/**
 * One link of the user-value chain, with the question it answers.
 *
 * The heading and the question come from the contract's own label tables, the
 * same ones the suite's Scorers table and the run page's stage cards use, so
 * the three surfaces cannot drift into three names for one stage.
 */

import type { ReactNode } from "react";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import { cn } from "@/lib/utils";

export function ScorecardGroupSection({
  stage,
  label,
  question,
  state,
  evidence,
  children,
}: {
  stage: UserValueStage;
  label: string;
  question: string;
  /**
   * How this stage went on the selected trial.
   *
   * The word lives here rather than on the strip above, so a reader looking at
   * a stage's rows does not have to scroll back up to learn whether the stage
   * passed — and so nothing states the same verdict twice.
   */
  state?: { label: string; tone: "passed" | "failed" | "neutral" };
  evidence?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" data-stage-group={stage}>
      <div className="space-y-0.5">
        <h4 className="text-[11px] font-medium text-foreground">
          {label}
          {state ? (
            <span
              data-testid="scorecard-group-state"
              className={cn(
                "ml-2 font-normal",
                state.tone === "failed" && "text-destructive",
                state.tone === "passed" && "text-success",
                state.tone === "neutral" && "text-muted-foreground",
              )}
            >
              {state.label}
            </span>
          ) : null}
        </h4>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {question}
        </p>
      </div>
      {evidence}
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}
