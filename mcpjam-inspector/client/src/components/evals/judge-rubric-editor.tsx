/**
 * The suite's judge criteria — the prose the judge is asked to grade against.
 *
 * THE PROBLEM THIS SOLVES. The last link of the user-value chain, "was the
 * user's actual request satisfied", is measured by a judge nobody could
 * instruct. A suite could set the judge's model and threshold and nothing
 * else, so two suites in different domains asked the same question and got
 * scores that were never comparable — and nobody could say what the judge had
 * been asked, because the answer was a template constant.
 *
 * A criterion is PROSE WITH AN ID. The judge cites the id in its reasons, which
 * is what makes a verdict auditable rather than a number: "failed `cites`"
 * names the thing that failed. The id is therefore load-bearing, unique, and
 * validated to the same shape the backend enforces — a duplicate would make
 * `rubricHits` collapse into an arbitrary winner.
 *
 * VALIDATED HERE AND THERE. The backend refuses a bad rubric; this editor
 * refuses it first, because a refusal that arrives after the save takes the
 * whole batched commit down with it — including the settings beside it that
 * were fine.
 */

import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { EvalJudgeRubric, EvalJudgeRubricCriterion } from "./types";

/** Mirrored by hand from the backend's `convex/lib/judgeConfig.ts`. */
export const MAX_JUDGE_RUBRIC_CRITERIA = 25;
export const MAX_JUDGE_CRITERION_ID_LENGTH = 64;
export const MAX_JUDGE_CRITERION_LABEL_LENGTH = 200;
export const MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH = 1000;
export const JUDGE_CRITERION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A label turned into an id a person would have written themselves.
 *
 * Auto-minted on FIRST entry only, and editable after. An id that keeps
 * following its label would silently retire a suite's calibration every time
 * somebody fixed a typo — the rubric hash is what the agreement rate is
 * measured against.
 */
export function slugifyCriterionId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_JUDGE_CRITERION_ID_LENGTH);
  return slug.length > 0 ? slug : "criterion";
}

/** A unique id for a new criterion, given the ones already present. */
export function uniqueCriterionId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(
      0,
      MAX_JUDGE_CRITERION_ID_LENGTH - String(suffix).length - 1,
    )}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** Why this criterion cannot be saved, or `undefined`. One message, the first. */
export function criterionError(
  criterion: EvalJudgeRubricCriterion,
  index: number,
  all: EvalJudgeRubricCriterion[],
): string | undefined {
  if (!JUDGE_CRITERION_ID_PATTERN.test(criterion.id)) {
    return "Id must be 1–64 characters of letters, digits, hyphen or underscore.";
  }
  if (all.some((other, at) => at !== index && other.id === criterion.id)) {
    // The judge cites ids in its reasons and `rubricHits` correlates by them,
    // so two criteria sharing one id collapse into an arbitrary winner.
    return "Ids must be unique — the judge cites them in its reasons.";
  }
  const label = criterion.label.trim();
  if (label.length === 0) return "A criterion needs a label.";
  if (criterion.label.length > MAX_JUDGE_CRITERION_LABEL_LENGTH) {
    return `Label must be at most ${MAX_JUDGE_CRITERION_LABEL_LENGTH} characters.`;
  }
  if (
    (criterion.description?.length ?? 0) >
    MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH
  ) {
    return `Description must be at most ${MAX_JUDGE_CRITERION_DESCRIPTION_LENGTH} characters.`;
  }
  return undefined;
}

/** True when every criterion is saveable. An empty rubric is valid: it clears. */
export function isRubricValid(rubric: EvalJudgeRubric | undefined): boolean {
  const criteria = rubric?.criteria ?? [];
  if (criteria.length > MAX_JUDGE_RUBRIC_CRITERIA) return false;
  return criteria.every(
    (criterion, index) =>
      criterionError(criterion, index, criteria) === undefined,
  );
}

export function JudgeRubricEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: EvalJudgeRubric | undefined;
  /**
   * `undefined` means NO RUBRIC, which the draft turns into the `null` that
   * clears the field. An empty criteria list is not a rubric that asks
   * nothing — the backend refuses one — so removing the last criterion is a
   * clear rather than an empty save.
   */
  onChange: (next: EvalJudgeRubric | undefined) => void;
  disabled?: boolean;
}) {
  const fieldId = useId();
  const criteria = value?.criteria ?? [];
  const atCap = criteria.length >= MAX_JUDGE_RUBRIC_CRITERIA;

  const commit = (next: EvalJudgeRubricCriterion[]) =>
    onChange(next.length === 0 ? undefined : { criteria: next });

  const updateAt = (index: number, patch: Partial<EvalJudgeRubricCriterion>) =>
    commit(
      criteria.map((criterion, at) =>
        at === index ? { ...criterion, ...patch } : criterion,
      ),
    );

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= criteria.length) return;
    const next = criteria.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <div className="space-y-2">
      {criteria.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">
          No criteria. The judge grades each case against its own expected
          output alone.
        </p>
      ) : null}
      {criteria.map((criterion, index) => {
        const error = criterionError(criterion, index, criteria);
        return (
          <div
            key={index}
            className="space-y-1.5 rounded-md border border-border/60 p-2"
            data-criterion-index={index}
          >
            <div className="flex items-center gap-2">
              <input
                className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                value={criterion.label}
                placeholder="What the judge should look for"
                aria-label={`Criterion ${index + 1} label`}
                disabled={disabled}
                onChange={(event) => {
                  const label = event.target.value;
                  // The id is minted from the FIRST label only, then left
                  // alone: an id that followed its label would retire the
                  // suite's calibration on every typo fix.
                  const shouldMint =
                    criterion.label.trim().length === 0 &&
                    label.trim().length > 0;
                  updateAt(index, {
                    label,
                    ...(shouldMint
                      ? {
                          id: uniqueCriterionId(
                            slugifyCriterionId(label),
                            new Set(
                              criteria
                                .filter((_, at) => at !== index)
                                .map((other) => other.id),
                            ),
                          ),
                        }
                      : {}),
                  });
                }}
              />
              <input
                className="h-7 w-32 rounded-md border border-input bg-background px-2 font-mono text-[11px] text-foreground"
                value={criterion.id}
                placeholder="id"
                aria-label={`Criterion ${index + 1} id`}
                disabled={disabled}
                onChange={(event) =>
                  updateAt(index, { id: event.target.value })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={`Move criterion ${index + 1} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={`Move criterion ${index + 1} down`}
                disabled={disabled || index === criteria.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                aria-label={`Remove criterion ${index + 1}`}
                disabled={disabled}
                onClick={() => commit(criteria.filter((_, at) => at !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground"
              rows={2}
              value={criterion.description ?? ""}
              placeholder="Optional detail the judge should apply"
              aria-label={`Criterion ${index + 1} description`}
              disabled={disabled}
              onChange={(event) =>
                updateAt(index, {
                  description:
                    event.target.value.length === 0
                      ? undefined
                      : event.target.value,
                })
              }
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={criterion.required === true}
                disabled={disabled}
                onChange={(event) =>
                  updateAt(index, {
                    required: event.target.checked ? true : undefined,
                  })
                }
              />
              Required
            </label>
            {error ? (
              <p
                className="text-[11px] text-destructive"
                data-criterion-error={index}
              >
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          id={fieldId}
          disabled={disabled || atCap}
          onClick={() =>
            commit([
              ...criteria,
              {
                id: uniqueCriterionId(
                  "criterion",
                  new Set(criteria.map((other) => other.id)),
                ),
                label: "",
              },
            ])
          }
        >
          Add criterion
        </Button>
        <span className="text-[11px] text-muted-foreground/60">
          {criteria.length} of {MAX_JUDGE_RUBRIC_CRITERIA}
          {atCap ? " — at the limit" : ""}
        </span>
      </div>
    </div>
  );
}
