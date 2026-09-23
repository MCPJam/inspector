/**
 * The rubric-checks judge slot on the suite settings page.
 *
 * Every grading criterion is asked on its own as a yes or no question, and
 * the author can add choice and score questions with a pass line each. The
 * answers become advisory score rows on every trial the goal-completion judge
 * grades: they never decide a run, and there is no role, threshold or model
 * to pick. So the card shows what will be asked and edits the authored
 * questions, and its On switch is the row in the evaluator table above.
 */

import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Plus, Trash2 } from "lucide-react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH,
  MAX_RUBRIC_CHECK_LABEL_LENGTH,
  MAX_RUBRIC_CHECK_LEVELS,
  MAX_RUBRIC_CHECK_OPTIONS,
  MAX_RUBRIC_CHECK_QUESTIONS,
  MIN_RUBRIC_CHECK_LEVELS,
  MIN_RUBRIC_CHECK_OPTIONS,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import {
  blankRubricCheckQuestion,
  RUBRIC_CHECK_QUESTION_IDENTITY_HINT,
  rubricCheckQuestionError,
  withAddedOption,
  withOptionPassing,
  withoutLevel,
  withoutOption,
  withQuestionLabel,
  withRubricChecks,
} from "./rubric-checks-model";
import type { EvalJudgeConfig, EvalJudgeRubricCriterion } from "./types";

export const RUBRIC_CHECKS_CARD_COPY =
  "Each grading criterion is also asked on its own, as a yes or no question with a probability. Advisory: rubric checks describe a trial and never decide a run.";

export const RUBRIC_CHECKS_GOAL_OFF_COPY =
  "Rubric checks run on the trials the goal-completion judge grades, so they are paused while that judge is off.";

const INPUT_CLASS =
  "h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground";

export function RubricChecksJudgeCard({
  judgeConfig,
  onJudgeConfigChange,
  judgesCapabilities,
  criteria,
  goalJudgeOff,
  disabled = false,
}: {
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  judgesCapabilities?: SuiteCapabilities["judges"];
  criteria: readonly EvalJudgeRubricCriterion[];
  goalJudgeOff: boolean;
  disabled?: boolean;
}) {
  const template = judgesCapabilities?.rubricChecks?.template ?? null;
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const atCap = questions.length >= MAX_RUBRIC_CHECK_QUESTIONS;
  const slotOff = judgeConfig?.rubricChecks?.enabled === false;

  const commit = (next: RubricCheckQuestion[]) =>
    onJudgeConfigChange(withRubricChecks(judgeConfig, { questions: next }));
  const replaceAt = (index: number, next: RubricCheckQuestion) =>
    commit(questions.map((question, at) => (at === index ? next : question)));

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
          Rubric checks are off for this suite. Turn them on in the table above.
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

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-xs font-medium text-foreground">
            Your questions{" "}
            <span className="font-normal text-muted-foreground">
              (optional, up to {MAX_RUBRIC_CHECK_QUESTIONS})
            </span>
          </h5>
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || atCap}
              onClick={() =>
                commit([
                  ...questions,
                  blankRubricCheckQuestion("choice", questions),
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Choice
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || atCap}
              onClick={() =>
                commit([
                  ...questions,
                  blankRubricCheckQuestion("score", questions),
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Score
            </Button>
          </div>
        </div>
        {questions.map((question, index) => (
          <QuestionEditor
            key={index}
            index={index}
            question={question}
            error={rubricCheckQuestionError(question, index, questions)}
            disabled={disabled}
            onChange={(next) => replaceAt(index, next)}
            onLabelChange={(label) =>
              replaceAt(
                index,
                withQuestionLabel(
                  question,
                  label,
                  questions.filter((_, at) => at !== index),
                ),
              )
            }
            onRemove={() => commit(questions.filter((_, at) => at !== index))}
          />
        ))}
        {criteria.length > 0 || questions.length > 0 ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="rubric-checks-identity-hint"
          >
            {RUBRIC_CHECK_QUESTION_IDENTITY_HINT}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function QuestionEditor({
  index,
  question,
  error,
  disabled,
  onChange,
  onLabelChange,
  onRemove,
}: {
  index: number;
  question: RubricCheckQuestion;
  error: string | undefined;
  disabled: boolean;
  onChange: (next: RubricCheckQuestion) => void;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
}) {
  const fieldId = useId();
  const n = index + 1;
  const kindLabel = question.kind === "choice" ? "Choice" : "Score";
  return (
    <div
      className="space-y-1.5 rounded-md border border-border/60 p-2"
      data-rubric-question-index={index}
      aria-invalid={error ? true : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {kindLabel}
        </span>
        <input
          className={`${INPUT_CLASS} flex-1`}
          value={question.label}
          maxLength={MAX_RUBRIC_CHECK_LABEL_LENGTH}
          placeholder="Short name, shown on the scorecard"
          aria-label={`Question ${n} label`}
          disabled={disabled}
          onChange={(event) => onLabelChange(event.target.value)}
        />
        <input
          className={`${INPUT_CLASS} w-28 font-mono text-[11px]`}
          value={question.id}
          placeholder="id"
          aria-label={`Question ${n} id`}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...question, id: event.target.value })
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
          aria-label={`Remove question ${n}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <textarea
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground"
        rows={2}
        value={question.instructions}
        maxLength={MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH}
        placeholder={
          question.kind === "choice"
            ? "The question, for example: which best describes the answer's tone?"
            : "The question, for example: how completely did the answer cover the request?"
        }
        aria-label={`Question ${n} text`}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...question, instructions: event.target.value })
        }
      />
      {question.kind === "choice" ? (
        <ChoiceOptions
          n={n}
          question={question}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <ScoreLevels
          n={n}
          fieldId={fieldId}
          question={question}
          disabled={disabled}
          onChange={onChange}
        />
      )}
      {error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
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
