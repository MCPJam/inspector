import { forwardRef } from "react";
import { Scale } from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import type { EvalJudgeConfigOverride } from "@/components/evals/types";
import {
  JUDGE_MODE_WORD,
  RUBRIC_SOURCE_HINT,
  withCaseJudgeSkipped,
  type CaseScorecard,
} from "../case-scorecard/case-scorecard-model";
import { ProvenanceChip } from "../case-scorecard/provenance-chip";

/** The Expected outcome step's body: the goal sentence, then the judge. */
export const OutcomeStepBody = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (next: string) => void;
    card: CaseScorecard;
    judgeConfigOverride?: EvalJudgeConfigOverride;
    onJudgeConfigOverrideChange: (
      next: EvalJudgeConfigOverride | undefined,
    ) => void;
    readOnly: boolean;
  }
>(function OutcomeStepBody(
  {
    value,
    onChange,
    card,
    judgeConfigOverride,
    onJudgeConfigOverrideChange,
    readOnly,
  },
  ref,
) {
  const facts = card.judge.judge;
  return (
    <div className="space-y-3">
      <Textarea
        ref={ref}
        id="case-steps-expected-outcome"
        aria-label="Expected outcome"
        aria-describedby="case-steps-expected-outcome-help"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        rows={2}
        placeholder={
          readOnly ? "No expected outcome" : "Describe what success looks like…"
        }
        className="min-h-[72px] resize-y rounded-lg bg-card px-3.5 py-3 font-mono text-[15px] leading-[22px]"
      />
      {facts ? (
        <p
          id="case-steps-expected-outcome-help"
          className="text-sm text-muted-foreground"
        >
          {RUBRIC_SOURCE_HINT[facts.rubricSource]}
        </p>
      ) : null}
      {facts && facts.suiteMode !== "off" ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
          data-testid="case-steps-judge"
        >
          <Scale className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium">Judge</span>
          <ProvenanceChip provenance="suite" />
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {[
              facts.model,
              `threshold ${facts.threshold}`,
              `${facts.suiteCriteriaCount} suite criteria`,
              JUDGE_MODE_WORD[facts.suiteMode],
              card.judge.role === "required" ? "blocking" : "non-blocking",
            ].join(" · ")}
          </span>
          {readOnly ? null : (
            <div className="flex items-center gap-2">
              <Switch
                id="case-steps-judge-skip"
                checked={facts.skippedForCase}
                onCheckedChange={(skipped) =>
                  onJudgeConfigOverrideChange(
                    withCaseJudgeSkipped(judgeConfigOverride, skipped),
                  )
                }
              />
              <Label htmlFor="case-steps-judge-skip" className="text-sm">
                Skip for this case
              </Label>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
