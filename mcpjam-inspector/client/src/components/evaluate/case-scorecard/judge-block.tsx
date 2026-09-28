/**
 * The judge, as the last scorer under User value.
 *
 * WHAT THIS FIXES. The old form had a lone input — "What does a good answer
 * accomplish?" — under a hint that read "Model grader · advisory". That hint
 * was already wrong (the judge's role is the suite's Gate / Warn / Report
 * setting), and everything else about the judge was invisible: which model
 * grades this, against what threshold, whether the suite's criteria also
 * apply, whether the judge even runs. Worst of all, a case with no sentence
 * still gets judged — the backend derives a rubric from the route, or falls
 * back to the suite's criteria, or grades the request itself with the score
 * capped. The page said none of that, so an author could not tell what their
 * sentence was replacing.
 *
 * The hint now mirrors the backend's own precedence, and the facts line says
 * what will actually happen. The one control beyond the sentence is the one
 * per-case override the backend admits: skip the judge for this case.
 */

import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import { Button } from "@mcpjam/design-system/button";
import { RoleChip } from "@/components/evals/scorer-role-control";
import { ProvenanceChip } from "./provenance-chip";
import { RowMarker } from "./row-marker";
import {
  JUDGE_MODE_WORD,
  RUBRIC_SOURCE_HINT,
  type ScorecardRow,
} from "./case-scorecard-model";

export function JudgeBlock({
  row,
  readOnly,
  onExpectedOutputChange,
  onSkippedChange,
  onOpenSuiteSettings,
}: {
  row: ScorecardRow;
  readOnly: boolean;
  onExpectedOutputChange: (next: string) => void;
  /** Absent on a surface that cannot write the case's judge override. */
  onSkippedChange?: (skipped: boolean) => void;
  onOpenSuiteSettings?: () => void;
}) {
  const judge = row.judge;
  if (!judge) return null;
  const suiteOff = judge.suiteMode === "off";

  return (
    <li
      data-testid="case-judge-block"
      data-row-key={row.key}
      data-runs={judge.runsForCase ? "yes" : "no"}
      className="space-y-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <RowMarker row={row} />
        <ProvenanceChip provenance="judge" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {row.label}
        </span>
        <RoleChip role={row.role} />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="simple-case-rubric"
          className="text-[11px] font-medium text-foreground"
        >
          What does a good answer accomplish?
        </Label>
        <Input
          id="simple-case-rubric"
          value={judge.goal}
          onChange={(event) => onExpectedOutputChange(event.target.value)}
          placeholder="One sentence the judge scores against"
          className="h-8 font-mono text-xs"
          readOnly={readOnly}
        />
        <p
          className="text-[11px] leading-snug text-muted-foreground"
          data-testid="case-judge-rubric-hint"
          data-rubric-source={judge.rubricSource}
        >
          {judge.rubricSource === "suite_criteria"
            ? `No goal sentence or route — the judge grades against the suite's ${judge.suiteCriteriaCount} criteria.`
            : RUBRIC_SOURCE_HINT[judge.rubricSource]}
        </p>
      </div>

      <p
        className="text-[11px] text-muted-foreground"
        data-testid="case-judge-facts"
      >
        {suiteOff ? (
          "Judge is off for this suite."
        ) : (
          <>
            {judge.model} · threshold {judge.threshold} ·{" "}
            {judge.suiteCriteriaCount === 1
              ? "1 suite criterion"
              : `${judge.suiteCriteriaCount} suite criteria`}{" "}
            · {JUDGE_MODE_WORD[judge.suiteMode]}
          </>
        )}
        {onOpenSuiteSettings ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-1 h-5 px-1 text-[11px] text-muted-foreground"
            onClick={onOpenSuiteSettings}
          >
            Edit in suite settings
          </Button>
        ) : null}
      </p>

      {/*
        Hidden when the suite's judge is off: offering to skip something that
        is not going to run is a control with no effect, and reading it as a
        report of the judge's state would be worse.
      */}
      {suiteOff || readOnly || !onSkippedChange ? null : (
        <div className="flex items-center gap-2">
          <Switch
            id="case-judge-skip"
            checked={judge.skippedForCase}
            onCheckedChange={onSkippedChange}
            aria-label="Skip the judge for this case"
          />
          <Label
            htmlFor="case-judge-skip"
            className="text-[11px] text-muted-foreground"
          >
            Skip the judge for this case
          </Label>
          <span className="text-[11px] text-muted-foreground/70">
            Applies to the next saved run.
          </span>
        </div>
      )}
    </li>
  );
}
