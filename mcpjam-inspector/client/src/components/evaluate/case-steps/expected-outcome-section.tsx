/**
 * Expected outcome: one sentence for the whole case, stored in
 * `expectedOutput` (O2), with the judge that grades it underneath.
 */

import { forwardRef } from "react";
import { Textarea } from "@mcpjam/design-system/textarea";
import { JudgeBlock } from "../case-scorecard/judge-block";
import type { ScorecardRow } from "../case-scorecard/case-scorecard-model";
import { StepRail } from "./step-card";

export const ExpectedOutcomeSection = forwardRef<
  HTMLTextAreaElement,
  {
    ordinal: number;
    value: string;
    judgeRow: ScorecardRow;
    readOnly: boolean;
    onChange: (next: string) => void;
    onJudgeSkippedChange?: (skipped: boolean) => void;
    onOpenSuiteSettings?: () => void;
  }
>(function ExpectedOutcomeSection(
  {
    ordinal,
    value,
    judgeRow,
    readOnly,
    onChange,
    onJudgeSkippedChange,
    onOpenSuiteSettings,
  },
  ref,
) {
  return (
    <StepRail
      marker={ordinal}
      label={`Step ${ordinal}`}
      testId="case-steps-expected-outcome"
    >
      <section className="space-y-3 rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <label
            htmlFor="case-steps-expected-outcome"
            className="text-lg font-semibold text-card-foreground"
          >
            Expected outcome
          </label>
          <p className="text-sm text-muted-foreground">
            One goal for the whole case. The judge grades it after the run.
          </p>
        </div>
        <Textarea
          ref={ref}
          id="case-steps-expected-outcome"
          value={value}
          rows={2}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            readOnly
              ? "No expected outcome"
              : "Describe what a successful run looks like…"
          }
          className="min-h-[72px] resize-y rounded-lg border-input bg-card px-3.5 py-3 font-mono text-sm text-card-foreground"
        />
        <ul>
          <JudgeBlock
            row={judgeRow}
            readOnly={readOnly}
            showGoalInput={false}
            onExpectedOutputChange={onChange}
            onSkippedChange={onJudgeSkippedChange}
            onOpenSuiteSettings={onOpenSuiteSettings}
          />
        </ul>
      </section>
    </StepRail>
  );
});
