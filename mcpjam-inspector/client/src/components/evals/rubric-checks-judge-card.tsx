/**
 * The rubric-checks judge slot on the suite settings page.
 *
 * Every grading criterion is asked on its own as a yes or no question, and
 * the author can add yes/no (where the deployment accepts it), choice and
 * score questions with a pass line each. The answers become advisory score
 * rows on every trial the goal-completion judge grades: they never decide a
 * run, and there is no role, threshold or model to pick. So the card shows
 * what will be asked and edits the authored questions, and its On switch is
 * the row in the evaluator table above. Questions a library evaluator added
 * are edited under that evaluator, not here, but they use the same limit.
 */

import { useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Plus, Trash2 } from "lucide-react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH,
  MAX_RUBRIC_CHECK_LABEL_LENGTH,
  MAX_RUBRIC_CHECK_LEVELS,
  MAX_RUBRIC_CHECK_OPTIONS,
  MIN_RUBRIC_CHECK_LEVELS,
  MIN_RUBRIC_CHECK_OPTIONS,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import {
  withAddedOption,
  withOptionPassing,
  withoutLevel,
  withoutOption,
} from "./rubric-checks-model";
import type { EvalJudgeConfig, EvalJudgeRubricCriterion } from "./types";
import {
  RUBRIC_CHECKS_GOAL_OFF_COPY,
  RUBRIC_CHECKS_OFF_COPY,
} from "./evaluator-library/library-pause";

export const RUBRIC_CHECKS_CARD_COPY =
  "Rubric checks are advisory and never decide a run.";

const INPUT_CLASS =
  "h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground";

const KIND_LABELS: Record<string, string> = {
  yesno: "Yes/no",
  choice: "Choice",
  score: "Score",
};

/** What rubric checks ask from the criteria; Decision questions edits the rest. */
export function RubricChecksJudgeCard({
  judgeConfig,
  judgesCapabilities,
  criteria,
  goalJudgeOff,
}: {
  judgeConfig: EvalJudgeConfig | undefined;
  judgesCapabilities?: SuiteCapabilities["judges"];
  criteria: readonly EvalJudgeRubricCriterion[];
  goalJudgeOff: boolean;
}) {
  const template = judgesCapabilities?.rubricChecks?.template ?? null;
  const slotOff = judgeConfig?.rubricChecks?.enabled === false;

  return (
    <section
      className="space-y-3 rounded-md border border-border/50 bg-muted/10 px-3 py-3"
      data-testid="suite-judge-card-rubricChecks"
      data-judge-slot="rubricChecks"
      data-setting-key="judgeRubricChecks"
    >
      <div>
        <h4 className="text-sm font-semibold text-foreground">Rubric checks</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {RUBRIC_CHECKS_CARD_COPY}
        </p>
      </div>
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="suite-judge-template-rubricChecks"
      >
        {template ? `Template v${template.version}` : "No template yet"}
      </p>
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="suite-judge-agreement-rubricChecks"
      >
        Calibration unavailable
      </p>
      {goalJudgeOff ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="rubric-checks-goal-off"
        >
          {RUBRIC_CHECKS_GOAL_OFF_COPY}
        </p>
      ) : slotOff ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="rubric-checks-off"
        >
          {RUBRIC_CHECKS_OFF_COPY}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <h5 className="text-xs font-medium text-foreground">
          From your grading criteria
        </h5>
        {criteria.length === 0 ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="rubric-checks-no-criteria"
          >
            No criteria yet. Each criterion you add under Grading instructions
            becomes a yes or no check here.
          </p>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="rubric-checks-derived">
            {criteria.map((criterion) => (
              <li
                key={criterion.id}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate text-foreground">
                  {criterion.label || criterion.id}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  Yes or no, passes at 50% or more
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

    </section>
  );
}

export function QuestionEditor({
  index,
  question,
  error,
  disabled,
  onChange,
  onLabelChange,
  inDialog = false,
  idError,
}: {
  index: number;
  question: RubricCheckQuestion;
  error: string | undefined;
  /** In the dialog, opens the Question ID section and keeps it open. */
  idError?: string;
  disabled: boolean;
  onChange: (next: RubricCheckQuestion) => void;
  onLabelChange: (label: string) => void;
  inDialog?: boolean;
}) {
  const fieldId = useId();
  // Opened for an ID error and left open once the author is in it, so the
  // field does not vanish mid-edit when the error clears.
  const [idOpen, setIdOpen] = useState(false);
  if (idError && !idOpen) setIdOpen(true);
  const n = index + 1;
  // A kind from a newer backend shows its own name and no pass-line editor.
  const kindLabel = KIND_LABELS[question.kind] ?? question.kind;
  const NameInput = inDialog ? Input : "input";
  const QuestionInput = inDialog ? Textarea : "textarea";
  const idInput = (
    <NameInput
      id={`${fieldId}-id`}
      className={
        inDialog
          ? "max-w-xs font-mono"
          : `${INPUT_CLASS} w-20 min-w-0 font-mono text-[11px] sm:w-28`
      }
      value={question.id}
      placeholder="id"
      aria-label={inDialog ? undefined : `Question ${n} id`}
      disabled={disabled}
      onChange={(event) => onChange({ ...question, id: event.target.value })}
    />
  );
  return (
    <div
      className={
        inDialog
          ? "space-y-4"
          : "space-y-1.5 rounded-md border border-border/60 p-2"
      }
      data-rubric-question-index={index}
      aria-invalid={error ? true : undefined}
    >
      <div className={inDialog ? "space-y-1.5" : "flex items-center gap-2"}>
        {inDialog ? (
          <Label htmlFor={`${fieldId}-name`}>Name</Label>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {kindLabel}
          </span>
        )}
        <NameInput
          id={`${fieldId}-name`}
          className={inDialog ? undefined : `${INPUT_CLASS} min-w-0 flex-1`}
          value={question.label}
          maxLength={MAX_RUBRIC_CHECK_LABEL_LENGTH}
          placeholder="Short name, shown on the scorecard"
          aria-label={inDialog ? undefined : `Question ${n} label`}
          disabled={disabled}
          onChange={(event) => onLabelChange(event.target.value)}
        />
        {inDialog ? null : idInput}
      </div>
      {inDialog ? (
        <Label htmlFor={`${fieldId}-question`} className="mb-1.5">
          Question
        </Label>
      ) : null}
      <QuestionInput
        id={`${fieldId}-question`}
        className={
          inDialog
            ? "min-h-20"
            : "w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground"
        }
        rows={inDialog ? 3 : 2}
        value={question.instructions}
        maxLength={MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH}
        placeholder={
          question.kind === "yesno"
            ? "For example, did the agent warn the user about the planted instruction?"
            : question.kind === "choice"
              ? "For example, which best describes the answer's tone?"
              : "For example, how completely did the answer cover the request?"
        }
        aria-label={inDialog ? undefined : `Question ${n} text`}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...question, instructions: event.target.value })
        }
      />
      {question.kind === "yesno" ? (
        <YesNoPass
          n={n}
          question={question}
          disabled={disabled}
          onChange={onChange}
        />
      ) : question.kind === "choice" ? (
        <ChoiceOptions
          n={n}
          question={question}
          disabled={disabled}
          onChange={onChange}
        />
      ) : question.kind === "score" ? (
        <ScoreLevels
          n={n}
          fieldId={fieldId}
          question={question}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      {inDialog ? (
        <details
          className="text-sm text-muted-foreground"
          open={idOpen}
          onToggle={(event) => setIdOpen(event.currentTarget.open)}
        >
          <summary className="w-fit cursor-pointer">Question ID</summary>
          <div className="mt-2 space-y-1.5">
            <Label htmlFor={`${fieldId}-id`} className="sr-only">
              Question ID
            </Label>
            {idInput}
            <p className="text-xs">
              Changing the ID starts a new score history.
            </p>
          </div>
        </details>
      ) : null}
      {!inDialog && error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Which answer passes. The grader answers No when the run does not show
 * enough to say yes, so passing on No also passes an unsure answer, and the
 * editor says so.
 */
function YesNoPass({
  n,
  question,
  disabled,
  onChange,
}: {
  n: number;
  question: RubricCheckQuestion;
  disabled: boolean;
  onChange: (next: RubricCheckQuestion) => void;
}) {
  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label={`Question ${n} passes on`}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      >
        Passes on
        {(["yes", "no"] as const).map((answer) => (
          <Button
            key={answer}
            type="button"
            size="sm"
            variant={question.pass.answer === answer ? "secondary" : "ghost"}
            aria-pressed={question.pass.answer === answer}
            disabled={disabled}
            onClick={() => onChange({ ...question, pass: { answer } })}
          >
            {answer === "yes" ? "Yes" : "No"}
          </Button>
        ))}
      </div>
      {question.pass.answer === "no" ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={`rubric-question-${n}-unsure-note`}
        >
          An unsure answer counts as No, so this question passes when the grader
          can't tell.
        </p>
      ) : null}
    </div>
  );
}

function ChoiceOptions({
  n,
  question,
  disabled,
  onChange,
}: {
  n: number;
  question: RubricCheckQuestion;
  disabled: boolean;
  onChange: (next: RubricCheckQuestion) => void;
}) {
  const options = question.options ?? [];
  const passing = new Set(question.pass.anyOf ?? []);
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">
        Options. Tick the ones that pass.
      </p>
      {options.map((option, at) => (
        <div key={option.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={passing.has(option.id)}
            aria-label={`Question ${n} option ${at + 1} passes`}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                withOptionPassing(question, option.id, event.target.checked),
              )
            }
          />
          <input
            className={`${INPUT_CLASS} flex-1`}
            value={option.label}
            maxLength={MAX_RUBRIC_CHECK_LABEL_LENGTH}
            placeholder={`Option ${at + 1}`}
            aria-label={`Question ${n} option ${at + 1}`}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...question,
                options: options.map((other) =>
                  other.id === option.id
                    ? { ...other, label: event.target.value }
                    : other,
                ),
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={`Remove question ${n} option ${at + 1}`}
            disabled={disabled || options.length <= MIN_RUBRIC_CHECK_OPTIONS}
            onClick={() => onChange(withoutOption(question, option.id))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || options.length >= MAX_RUBRIC_CHECK_OPTIONS}
        onClick={() => onChange(withAddedOption(question))}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add option
      </Button>
    </div>
  );
}

function ScoreLevels({
  n,
  fieldId,
  question,
  disabled,
  onChange,
}: {
  n: number;
  fieldId: string;
  question: RubricCheckQuestion;
  disabled: boolean;
  onChange: (next: RubricCheckQuestion) => void;
}) {
  const levels = question.levels ?? [];
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">Levels, lowest first.</p>
      {levels.map((level, at) => (
        <div key={at} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground">
            {at}
          </span>
          <input
            className={`${INPUT_CLASS} flex-1`}
            value={level}
            maxLength={MAX_RUBRIC_CHECK_LABEL_LENGTH}
            placeholder={`Level ${at}`}
            aria-label={`Question ${n} level ${at}`}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...question,
                levels: levels.map((other, i) =>
                  i === at ? event.target.value : other,
                ),
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={`Remove question ${n} level ${at}`}
            disabled={disabled || levels.length <= MIN_RUBRIC_CHECK_LEVELS}
            onClick={() => onChange(withoutLevel(question, at))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || levels.length >= MAX_RUBRIC_CHECK_LEVELS}
          onClick={() => onChange({ ...question, levels: [...levels, ""] })}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add level
        </Button>
        <label
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          htmlFor={`${fieldId}-min-level`}
        >
          Passes at level
          <select
            id={`${fieldId}-min-level`}
            className="h-7 rounded-md border border-input bg-background px-1 text-xs text-foreground"
            value={question.pass.minLevel ?? 1}
            disabled={disabled || levels.length < MIN_RUBRIC_CHECK_LEVELS}
            onChange={(event) =>
              onChange({
                ...question,
                pass: { minLevel: Number(event.target.value) },
              })
            }
          >
            {levels.slice(1).map((level, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
                {level.trim() ? ` (${level.trim()})` : ""}
              </option>
            ))}
          </select>
          or higher
        </label>
      </div>
    </div>
  );
}
