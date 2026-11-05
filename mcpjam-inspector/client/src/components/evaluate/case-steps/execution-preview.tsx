/**
 * The execution preview (C13): everything a run of the case does, in order —
 * steps with their assertions, after-run assertions, the expected outcome,
 * then the suite's default evaluators. A pure view of `buildExecutionPreview`,
 * so the editor and the Test run page show the same list.
 */

import { useState, type ReactNode } from "react";
import { Diamond, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { Predicate } from "@/shared/eval-matching";
import { isWidgetAssertion, type AssertStep } from "@/shared/steps";
import { summarizeStep } from "@/components/evals/step-fields";
import { scorerRowLabel } from "../case-scorecard/case-scorecard-model";
import { trackEvalNav } from "../nav/evaluate-nav-events";
import {
  buildExecutionPreview,
  type EditorAssertion,
  type ExecutionPreviewInput,
} from "./case-steps-model";

export type ExecutionPreviewSurface = "editor" | "test_run";

/** The diamond toggle beside a page title, and its open state. */
export function useExecutionPreviewToggle(surface: ExecutionPreviewSurface) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!open) trackEvalNav("eval_execution_preview_opened", { surface });
    setOpen(!open);
  };
  const button = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="size-8"
      aria-pressed={open}
      aria-label={open ? "Hide execution preview" : "Show execution preview"}
      title="Execution preview"
      onClick={toggle}
    >
      <Diamond className="size-4" aria-hidden="true" />
    </Button>
  );
  return { open, close: () => setOpen(false), button };
}

export function ExecutionPreviewPanel({
  input,
  onClose,
  onSelectStep,
}: {
  input: ExecutionPreviewInput;
  onClose: () => void;
  /** Present on surfaces where a step can be opened. */
  onSelectStep?: (stepId: string) => void;
}) {
  const preview = buildExecutionPreview(input);
  const { afterRunAssertions, expectedOutcome, suiteDefaultEvaluators } =
    preview;
  return (
    <aside
      className="flex min-h-0 w-full flex-col border-l border-border bg-background lg:w-80"
      aria-label="Execution preview"
      data-testid="execution-preview"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          Execution preview
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close execution preview"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <ol className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
        {preview.leadingAssertions.length > 0 ? (
          <PreviewSection title="Before step 1">
            <AssertionList assertions={preview.leadingAssertions} />
          </PreviewSection>
        ) : null}
        {preview.steps.map((step) => (
          <PreviewSection
            key={step.step.id}
            title={`${step.ordinal}. ${step.label}`}
            detail={summarizeStep(step.step)}
            onSelect={
              onSelectStep ? () => onSelectStep(step.step.id) : undefined
            }
          >
            <AssertionList assertions={step.assertions} />
          </PreviewSection>
        ))}
        <PreviewSection title={afterRunAssertions.label}>
          <PredicateList
            predicates={afterRunAssertions.assertions}
            provenance="case"
            empty="None"
          />
        </PreviewSection>
        <PreviewSection title="Expected outcome">
          <p className="text-muted-foreground">{expectedOutcome ?? "None"}</p>
        </PreviewSection>
        <PreviewSection title="Suite default evaluators">
          <PredicateList
            predicates={suiteDefaultEvaluators.assertions}
            provenance="suite"
            empty={
              suiteDefaultEvaluators.replacedCount > 0
                ? `Replaced by this case (${suiteDefaultEvaluators.replacedCount})`
                : "None"
            }
          />
        </PreviewSection>
      </ol>
    </aside>
  );
}

function PreviewSection({
  title,
  detail,
  onSelect,
  children,
}: {
  title: string;
  detail?: string;
  onSelect?: () => void;
  children: ReactNode;
}) {
  const heading = (
    <>
      <span className="font-medium text-foreground">{title}</span>
      {detail ? (
        <span className="block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </>
  );
  return (
    <li className="space-y-1.5">
      {onSelect ? (
        <button
          type="button"
          className="block w-full min-w-0 text-left hover:underline"
          onClick={onSelect}
        >
          {heading}
        </button>
      ) : (
        <div className="min-w-0">{heading}</div>
      )}
      {children}
    </li>
  );
}

function AssertionList({ assertions }: { assertions: EditorAssertion[] }) {
  if (assertions.length === 0) return null;
  return (
    <ul className="space-y-1 border-l border-border pl-3">
      {assertions.map(({ step }) => (
        <li key={step.id} className="truncate text-muted-foreground">
          {assertionLabel(step)}
        </li>
      ))}
    </ul>
  );
}

function PredicateList({
  predicates,
  provenance,
  empty,
}: {
  predicates: Predicate[];
  provenance: "case" | "suite";
  empty: string;
}) {
  if (predicates.length === 0)
    return <p className="text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1 border-l border-border pl-3">
      {predicates.map((predicate, index) => (
        <li
          key={`${predicate.type}:${index}`}
          className="truncate text-muted-foreground"
        >
          {scorerRowLabel(predicate, provenance)}
        </li>
      ))}
    </ul>
  );
}

function assertionLabel(step: AssertStep): string {
  const { assertion } = step;
  if (isWidgetAssertion(assertion) || assertion.type === "toolCalledWith")
    return summarizeStep(step);
  return scorerRowLabel(assertion, "step");
}
