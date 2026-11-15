import { ArrowRight } from "lucide-react";
import { CASE_FIELD_LABEL } from "./case-field-dependency";
import type { CaseField } from "./evaluator-library-types";
import { OutcomeTag } from "./outcome-tag";

export type CombineFlowProps = {
  /** Required checks that gate the result. */
  requiredCount: number;
  /** Short label for an advisory question that runs after a failure. */
  explainStep?: string;
  /** The case field the evaluator needs; adds the Not applicable path. */
  dependency?: CaseField;
};

function Step({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md border border-border bg-popover px-2 text-xs">
      {children}
    </span>
  );
}

function Arrow() {
  return <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />;
}

/**
 * A one-line diagram of how an evaluator's checks become its result. Built
 * from the evaluator definition so it cannot drift from what actually runs.
 */
export function CombineFlow({
  requiredCount,
  explainStep,
  dependency,
}: CombineFlowProps) {
  const checks = `${requiredCount} required ${requiredCount === 1 ? "check" : "checks"}`;
  return (
    <div
      role="group"
      aria-label="How results combine"
      className="flex flex-col gap-2"
    >
      {dependency ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Step>{`No ${CASE_FIELD_LABEL[dependency]} in the case`}</Step>
          <Arrow />
          <OutcomeTag outcome="not_applicable" label="Not applicable" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Step>{checks}</Step>
        <Arrow />
        <Step>All pass</Step>
        <Arrow />
        <OutcomeTag outcome="passed" label="Passed" />
        <span className="px-1 text-xs text-muted-foreground">or</span>
        <Step>Any fails</Step>
        <Arrow />
        <OutcomeTag outcome="failed" label="Failed" />
        {explainStep ? (
          <>
            <Arrow />
            <Step>{explainStep}</Step>
          </>
        ) : null}
      </div>
    </div>
  );
}
