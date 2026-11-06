/**
 * Expected outcome: the goal sentence the judge grades, the hint saying what
 * the judge will read, and the judge row with its per-case skip switch.
 */
import { Scale } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  JUDGE_MODE_WORD,
  RUBRIC_SOURCE_HINT,
  withCaseJudgeSkipped,
  type CaseScorecard,
} from "../case-scorecard/case-scorecard-model";
import { ProvenanceChip, StepSection } from "./case-step-parts";
import type { CaseStepsDraft, DraftEdit } from "./case-step-edits";

/** "<model> · threshold <t> · <n> suite criteria · <mode> · <role>", or null when off. */
export function judgeFactsLine(card: CaseScorecard): string | null {
  const facts = card.judge.judge;
  if (!facts || facts.suiteMode === "off") return null;
  const criteria =
    facts.suiteCriteriaCount === 1
      ? "1 suite criterion"
      : `${facts.suiteCriteriaCount} suite criteria`;
  const role = card.judge.role === "advisory" ? "non-blocking" : "blocking";
  return `${facts.model} · threshold ${facts.threshold} · ${criteria} · ${JUDGE_MODE_WORD[facts.suiteMode]} · ${role}`;
}

export function CaseOutcome({
  ordinal,
  draft,
  card,
  readOnly,
  flash,
  onEdit,
  onOpenSuiteSettings,
}: {
  ordinal: number;
  draft: CaseStepsDraft;
  card: CaseScorecard;
  readOnly: boolean;
  flash: boolean;
  onEdit: (edit: DraftEdit) => void;
  onOpenSuiteSettings: () => void;
}) {
  const facts = card.judge.judge;
  const judgeOff = facts?.suiteMode === "off";
  return (
    <StepSection
      marker={ordinal}
      id="case-steps-outcome"
      anchor="outcome"
      flash={flash}
      title="Expected outcome"
      subtitle="One goal for the whole case. The judge grades it after the run."
    >
      <div className="space-y-2">
        <Textarea
          aria-label="Expected outcome"
          aria-describedby={judgeOff ? undefined : "case-steps-rubric-hint"}
          value={draft.expectedOutput}
          rows={2}
          readOnly={readOnly}
          placeholder="Describe the outcome you expect…"
          onChange={(event) => {
            const expectedOutput = event.target.value;
            onEdit((current) => ({ ...current, expectedOutput }));
          }}
          className="min-h-[64px] resize-y rounded-lg border-input bg-card px-3.5 py-3 font-mono text-sm leading-[22px] text-card-foreground md:text-sm"
        />
        {judgeOff || !facts ? null : (
          <p
            id="case-steps-rubric-hint"
            className="text-xs text-muted-foreground"
          >
            {RUBRIC_SOURCE_HINT[facts.rubricSource]}
          </p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-2 gap-y-1">
          <Scale
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="text-[13px] font-medium text-card-foreground">
            Judge
          </span>
          <ProvenanceChip suite />
          <span className="min-w-0 text-xs text-muted-foreground">
            {judgeOff ? "Judge is off for this suite." : judgeFactsLine(card)}
          </span>
        </div>
        {judgeOff ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onOpenSuiteSettings}
          >
            Edit in suite settings
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Switch
              id="case-steps-judge-skip"
              checked={facts?.skippedForCase ?? false}
              disabled={readOnly}
              aria-label="Skip the judge for this case"
              onCheckedChange={(skipped) =>
                onEdit((current) => ({
                  ...current,
                  judgeConfigOverride: withCaseJudgeSkipped(
                    current.judgeConfigOverride,
                    skipped,
                  ),
                }))
              }
            />
            <Label
              htmlFor="case-steps-judge-skip"
              className="text-xs font-normal text-card-foreground"
            >
              Skip for this case
            </Label>
          </div>
        )}
      </div>
    </StepSection>
  );
}
