import { cn } from "@/lib/utils";
import type { CaseField } from "./evaluator-library-types";

/** How each case field reads in a sentence, singular and lower case. */
export const CASE_FIELD_LABEL: Record<CaseField, string> = {
  expectedToolCalls: "expected tool calls",
  callBudget: "call budget",
  expectedOutput: "expected output",
  expectsClarification: "“expects clarification”",
  postCondition: "post-condition",
  attackFixture: "attack fixture",
  allowedPersonalData: "allowed personal data",
};

export type CaseFieldDependencyProps = {
  field: CaseField;
} & (
  | {
      /** Suite context: how many of the suite's cases fill the field. */
      coverage: { filled: number; total: number };
      filled?: never;
    }
  | {
      /** Case context: whether this one case fills the field. */
      filled: boolean;
      coverage?: never;
    }
  | { coverage?: never; filled?: never }
);

type Tone = "neutral" | "missing" | "inactive";

/**
 * Says that an evaluator reads a field from the test case, and whether the
 * case fills it in. Without this, an evaluator that reports Not applicable
 * looks broken instead of unconfigured.
 */
export function CaseFieldDependency(props: CaseFieldDependencyProps) {
  const label = CASE_FIELD_LABEL[props.field];
  let tone: Tone = "neutral";
  let text = `Uses ${label}`;

  if (props.coverage) {
    const missing = props.coverage.total - props.coverage.filled;
    if (missing > 0) {
      tone = "missing";
      text = `${missing} of ${props.coverage.total} cases have no ${label}`;
    }
  } else if (props.filled === false) {
    tone = "inactive";
    text = `Not applicable · this case has no ${label}`;
  }

  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs",
        tone === "neutral" && "text-muted-foreground",
        tone === "missing" && "text-warning",
        tone === "inactive" && "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "neutral" && "bg-info",
          tone === "missing" && "bg-warning",
          tone === "inactive" && "bg-muted-foreground",
        )}
      />
      {text}
    </span>
  );
}
