import { useId } from "react";
import { MAX_JUDGE_INSTRUCTIONS_LENGTH } from "@mcpjam/sdk/contract";
import type { EvalJudgeRubric } from "./types";
import { JudgeRubricEditor } from "./judge-rubric-editor";

/**
 * The suite's grading instructions and criteria: the prose the goal judge
 * reads, and — one question per criterion — what rubric checks ask.
 */
export function JudgeInstructionsEditor({
  value,
  onChange,
  disabled = false,
  rowIdentityHint,
}: {
  value: EvalJudgeRubric | undefined;
  onChange: (value: EvalJudgeRubric | undefined) => void;
  disabled?: boolean;
  /** Passed through to the criteria list; see `RUBRIC_CHECK_ROW_IDENTITY_HINT`. */
  rowIdentityHint?: string;
}) {
  const id = useId();
  const instructions = value?.instructions ?? "";
  const criteria = value?.criteria ?? [];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-xs font-medium">
          Grading instructions{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={id}
          rows={3}
          disabled={disabled}
          value={instructions}
          maxLength={MAX_JUDGE_INSTRUCTIONS_LENGTH}
          aria-describedby={`${id}-help ${id}-count`}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
          placeholder="Only count success when a tool result confirms it; saying 'done' is not enough."
          onChange={(event) => {
            const next = event.target.value;
            onChange(
              next.length
                ? { ...value, instructions: next }
                : criteria.length
                ? { criteria }
                : undefined,
            );
          }}
          onBlur={() => {
            const trimmed = instructions.trim();
            if (trimmed !== instructions)
              onChange(
                trimmed
                  ? { ...value, instructions: trimmed }
                  : criteria.length
                  ? { criteria }
                  : undefined,
              );
          }}
        />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          Extra rules the judge applies to every test, alongside its task and
          expected outcome.
        </p>
        <p
          id={`${id}-count`}
          className="text-right text-xs text-muted-foreground"
        >
          {instructions.length}/{MAX_JUDGE_INSTRUCTIONS_LENGTH}
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">
          Grading criteria{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </p>
        <JudgeRubricEditor
          criteriaOnly
          value={value}
          onChange={onChange}
          disabled={disabled}
          rowIdentityHint={rowIdentityHint}
        />
      </div>
    </div>
  );
}
