/**
 * Pure helpers for the rubric-checks judge slot: validation that mirrors the
 * backend's `assertValidRubricChecksConfig`, and the small edits the settings
 * card makes to a question.
 *
 * VALIDATED HERE AND THERE, like the rubric editor. The settings save is one
 * batched mutation, so a question the backend refuses would take every other
 * setting in the same save down with it. This module refuses it first, with
 * the same rules, and the card shows the first problem under the question.
 */

import {
  MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH,
  MAX_RUBRIC_CHECK_LABEL_LENGTH,
  MAX_RUBRIC_CHECK_LEVELS,
  MAX_RUBRIC_CHECK_OPTIONS,
  MAX_RUBRIC_CHECK_QUESTIONS,
  MIN_RUBRIC_CHECK_LEVELS,
  MIN_RUBRIC_CHECK_OPTIONS,
  type RubricCheckQuestion,
  type RubricChecksJudgeSlot,
} from "@/components/shared/session-quality/judge-config";
import {
  JUDGE_CRITERION_ID_PATTERN,
  MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH,
  slugifyCriterionId,
  uniqueCriterionId,
} from "./judge-rubric-editor";
import type { EvalJudgeConfig } from "./types";

/**
 * Shown on the rubric-checks card. The same fact as the criteria editor's
 * hint, for the questions authored here.
 */
export const RUBRIC_CHECK_QUESTION_IDENTITY_HINT =
  "Editing a question's wording, options, levels or pass line starts a new rubric-check row, so baseline comparisons show it as removed and added.";

function boundedTextError(
  value: string | undefined,
  max: number,
  what: string,
): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return `${what} is required.`;
  }
  if (value.length > max) return `${what} must be at most ${max} characters.`;
  return undefined;
}

/** Why this question cannot be saved, or `undefined`. The first problem only. */
export function rubricCheckQuestionError(
  question: RubricCheckQuestion,
  index: number,
  all: readonly RubricCheckQuestion[],
): string | undefined {
  if (!JUDGE_CRITERION_ID_PATTERN.test(question.id)) {
    return "Id must be 1 to 64 letters, digits, hyphens or underscores.";
  }
  if (all.some((other, at) => at !== index && other.id === question.id)) {
    return "Ids must be unique: each one names a score row.";
  }
  const label = boundedTextError(
    question.label,
    MAX_RUBRIC_CHECK_LABEL_LENGTH,
    "A label",
  );
  if (label) return label;
  const instructions = boundedTextError(
    question.instructions,
    MAX_RUBRIC_CHECK_INSTRUCTIONS_LENGTH,
    "The question",
  );
  if (instructions) return instructions;

  if (question.kind === "choice") {
    const options = question.options ?? [];
    if (
      options.length < MIN_RUBRIC_CHECK_OPTIONS ||
      options.length > MAX_RUBRIC_CHECK_OPTIONS
    ) {
      return `A choice needs ${MIN_RUBRIC_CHECK_OPTIONS} to ${MAX_RUBRIC_CHECK_OPTIONS} options.`;
    }
    const ids = new Set<string>();
    for (const option of options) {
      if (!JUDGE_CRITERION_ID_PATTERN.test(option.id) || ids.has(option.id)) {
        return "Each option needs its own id.";
      }
      ids.add(option.id);
      const optionLabel = boundedTextError(
        option.label,
        MAX_RUBRIC_CHECK_LABEL_LENGTH,
        "Each option's label",
      );
      if (optionLabel) return optionLabel;
      if (
        (option.description?.length ?? 0) >
        MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH
      ) {
        return `An option's description must be at most ${MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH} characters.`;
      }
    }
    const anyOf = question.pass.anyOf ?? [];
    if (anyOf.length === 0 || anyOf.some((id) => !ids.has(id))) {
      return "Mark at least one option as passing.";
    }
    if (new Set(anyOf).size === ids.size) {
      // A pass line every answer clears measures nothing.
      return "At least one option must fail.";
    }
    return undefined;
  }

  const levels = question.levels ?? [];
  if (
    levels.length < MIN_RUBRIC_CHECK_LEVELS ||
    levels.length > MAX_RUBRIC_CHECK_LEVELS
  ) {
    return `A score needs ${MIN_RUBRIC_CHECK_LEVELS} to ${MAX_RUBRIC_CHECK_LEVELS} levels.`;
  }
  for (const level of levels) {
    const error = boundedTextError(
      level,
      MAX_RUBRIC_CHECK_LABEL_LENGTH,
      "Each level",
    );
    if (error) return error;
  }
  const minLevel = question.pass.minLevel;
  if (
    minLevel === undefined ||
    !Number.isInteger(minLevel) ||
    minLevel < 1 ||
    minLevel > levels.length - 1
  ) {
    return "Pick the lowest passing level; the lowest level itself cannot pass.";
  }
  return undefined;
}

/** True when the slot can be saved. An absent slot is valid. */
export function areRubricChecksValid(
  slot: RubricChecksJudgeSlot | undefined,
): boolean {
  const questions = slot?.questions ?? [];
  if (questions.length > MAX_RUBRIC_CHECK_QUESTIONS) return false;
  return questions.every(
    (question, index) =>
      rubricCheckQuestionError(question, index, questions) === undefined,
  );
}

/** Whether rubric checks run for this config, before case and run overrides. */
export function rubricChecksRun(judgeConfig: EvalJudgeConfig | undefined) {
  return (
    judgeConfig?.goalCompletion?.enabled !== false &&
    judgeConfig?.rubricChecks?.enabled !== false
  );
}

/**
 * The judge config with the rubric-checks slot replaced. An emptied question
 * list is dropped rather than stored as `[]`, so an untouched slot and one
 * whose questions were all removed read the same.
 */
export function withRubricChecks(
  judgeConfig: EvalJudgeConfig | undefined,
  patch: Partial<RubricChecksJudgeSlot>,
): EvalJudgeConfig {
  const next: RubricChecksJudgeSlot = {
    ...(judgeConfig?.rubricChecks ?? {}),
    ...patch,
  };
  if (next.questions && next.questions.length === 0) delete next.questions;
  return { ...judgeConfig, rubricChecks: next };
}

/** A new question of either kind, with an id no other question uses. */
export function blankRubricCheckQuestion(
  kind: RubricCheckQuestion["kind"],
  existing: readonly RubricCheckQuestion[],
): RubricCheckQuestion {
  const id = uniqueCriterionId(
    kind === "choice" ? "choice" : "score",
    new Set(existing.map((question) => question.id)),
  );
  if (kind === "choice") {
    return {
      id,
      kind,
      label: "",
      instructions: "",
      options: [
        { id: "option-1", label: "" },
        { id: "option-2", label: "" },
      ],
      pass: { anyOf: [] },
    };
  }
  return {
    id,
    kind,
    label: "",
    instructions: "",
    levels: ["", "", ""],
    pass: { minLevel: 2 },
  };
}

/**
 * A question relabelled. Its id is minted from the FIRST label only and then
 * left alone, the same rule the criteria editor follows: the id is the score
 * row's scorer id, and a typo fix should not move it. (The reworded question
 * is still a new definition, which the card's hint says.)
 */
export function withQuestionLabel(
  question: RubricCheckQuestion,
  label: string,
  others: readonly RubricCheckQuestion[],
): RubricCheckQuestion {
  const shouldMint =
    question.label.trim().length === 0 && label.trim().length > 0;
  if (!shouldMint) return { ...question, label };
  return {
    ...question,
    label,
    id: uniqueCriterionId(
      slugifyCriterionId(label),
      new Set(others.map((other) => other.id)),
    ),
  };
}

/** A choice question with one more (blank) option. */
export function withAddedOption(
  question: RubricCheckQuestion,
): RubricCheckQuestion {
  const options = question.options ?? [];
  const taken = new Set(options.map((option) => option.id));
  const id = uniqueCriterionId(`option-${options.length + 1}`, taken);
  return { ...question, options: [...options, { id, label: "" }] };
}

/** A choice question without one option, and without it in the pass line. */
export function withoutOption(
  question: RubricCheckQuestion,
  optionId: string,
): RubricCheckQuestion {
  return {
    ...question,
    options: (question.options ?? []).filter(
      (option) => option.id !== optionId,
    ),
    pass: {
      anyOf: (question.pass.anyOf ?? []).filter((id) => id !== optionId),
    },
  };
}

/** A choice question with one option marked passing, or not. */
export function withOptionPassing(
  question: RubricCheckQuestion,
  optionId: string,
  passes: boolean,
): RubricCheckQuestion {
  const anyOf = (question.pass.anyOf ?? []).filter((id) => id !== optionId);
  // Kept in option order, so the stored pass line does not depend on the
  // order the author ticked the boxes in.
  const next = new Set(passes ? [...anyOf, optionId] : anyOf);
  return {
    ...question,
    pass: {
      anyOf: (question.options ?? [])
        .map((option) => option.id)
        .filter((id) => next.has(id)),
    },
  };
}

/**
 * A score question without one level. The pass line keeps pointing at the
 * same level where it can, and is clamped into range where it cannot.
 */
export function withoutLevel(
  question: RubricCheckQuestion,
  index: number,
): RubricCheckQuestion {
  const levels = (question.levels ?? []).filter((_, at) => at !== index);
  const current = question.pass.minLevel ?? 1;
  const shifted = index < current ? current - 1 : current;
  const minLevel = Math.min(
    Math.max(shifted, 1),
    Math.max(levels.length - 1, 1),
  );
  return { ...question, levels, pass: { minLevel } };
}
