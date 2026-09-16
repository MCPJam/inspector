import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { MAX_JUDGE_INSTRUCTIONS_LENGTH } from "@mcpjam/sdk/contract";
import type { EvalJudgeRubric } from "./types";

export function JudgeInstructionsEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: EvalJudgeRubric | undefined;
  onChange: (value: EvalJudgeRubric | undefined) => void;
  disabled?: boolean;
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
      {criteria.length > 0 && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Additional grading criteria configured through the API.
          </p>
          <ul className="space-y-2 text-xs">
            {criteria.map((criterion, index) => (
              <li key={`${criterion.id}-${index}`}>
                <span className="font-medium">{criterion.label}</span>
                {criterion.required && <span> (required)</span>}
                <span className="ml-1 font-mono text-muted-foreground">
                  {criterion.id}
                </span>
                {criterion.description && (
                  <p className="text-muted-foreground">
                    {criterion.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange(
                instructions.trim()
                  ? { instructions: instructions.trim() }
                  : undefined,
              )
            }
          >
            Clear criteria
          </Button>
        </div>
      )}
    </div>
  );
}
