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
  footer,
  layout = "compact",
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
  /** Rendered between the heading and the rows. */
  evidence?: ReactNode;
  /** Rendered after the rows. */
  footer?: ReactNode;
  /**
   * `compact` is the authoring pane's dense list; `report` is the iteration
   * report, where the stage heading leads a section of its own.
   */
  layout?: "compact" | "report";
  children: ReactNode;
}) {
  const report = layout === "report";
  return (
    <section
      className={report ? "space-y-3" : "space-y-2"}
      data-stage-group={stage}
    >
      <div className={report ? "space-y-1" : "space-y-0.5"}>
        <h4
          className={cn(
            "flex items-center gap-2 text-foreground",
            report ? "text-base font-semibold" : "text-[11px] font-medium",
          )}
        >
          {label}
          {state ? (
            <span
              data-testid="scorecard-group-state"
              className={cn(
                report
                  ? "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  : "font-normal",
                state.tone === "failed" &&
                  (report
                    ? "bg-destructive/10 text-destructive"
                    : "text-destructive"),
                state.tone === "passed" &&
                  (report ? "bg-success/15 text-foreground" : "text-success"),
                state.tone === "neutral" &&
                  (report
                    ? "bg-muted text-muted-foreground"
                    : "text-muted-foreground"),
              )}
            >
              {state.label}
            </span>
          ) : null}
        </h4>
        <p
          className={cn(
            "text-muted-foreground",
            report ? "text-sm" : "text-[11px] leading-snug",
          )}
        >
          {question}
        </p>
      </div>
      {evidence}
      <ul className={report ? undefined : "space-y-1"}>{children}</ul>
      {footer}
    </section>
  );
}
