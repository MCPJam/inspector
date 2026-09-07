/**
 * One link of the user-value chain, with the question it answers.
 *
 * The heading and the question come from the contract's own label tables, the
 * same ones the suite's Scorers table and the run page's stage cards use, so
 * the three surfaces cannot drift into three names for one stage.
 */

import type { ReactNode } from "react";
import type { UserValueStage } from "@mcpjam/sdk/contract";

export function ScorecardGroupSection({
  stage,
  label,
  question,
  children,
}: {
  stage: UserValueStage;
  label: string;
  question: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" data-stage-group={stage}>
      <div className="space-y-0.5">
        <h4 className="text-[11px] font-medium text-foreground">{label}</h4>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {question}
        </p>
      </div>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}
