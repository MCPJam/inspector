import { ChevronRight, Diamond, Flag, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { labelForInlineAssert } from "@/shared/predicate-kinds";
import type { StepAssertionPayload } from "@/shared/steps";
import { describePredicates } from "../../evals/suite-settings-summary";
import type {
  EditorAssertion,
  EditorStep,
  ExecutionPreview,
} from "../case-steps/case-steps-model";

function assertionLabel(assertion: StepAssertionPayload): string {
  return "type" in assertion
    ? labelForInlineAssert(assertion.type)
    : "View assertion";
}

function stepDetail(editorStep: EditorStep): string | null {
  const { step } = editorStep;
  if (step.kind === "prompt") return step.prompt.trim() || null;
  if (step.kind === "toolCall") return step.toolName;
  return null;
}

const sectionLabel =
  "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/**
 * How this case runs, in order (C13): numbered steps with the assertions
 * that grade them, then after-run assertions, the expected outcome and the
 * suite's default evaluators. A step opens the case editor at that step.
 */
export function ExecutionPreviewPanel({
  preview,
  onOpenStep,
  onClose,
}: {
  /** `null` while the case is loading or when it no longer exists. */
  preview: ExecutionPreview | null | undefined;
  onOpenStep: (stepIndex: number) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Execution preview"
      className="h-fit rounded-xl border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Execution preview</h2>
          <p className="text-xs text-muted-foreground">
            How this case runs, in order. Click a step to open it in the test
            case.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Close execution preview"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="space-y-4 px-4 py-3">
        {preview === undefined ? (
          <p className="text-xs text-muted-foreground">
            Loading the test case…
          </p>
        ) : preview === null ? (
          <p className="text-xs text-muted-foreground">
            This test case was deleted, so there is nothing to preview.
          </p>
        ) : (
          <PreviewBody preview={preview} onOpenStep={onOpenStep} />
        )}
      </div>
    </aside>
  );
}

function PreviewBody({
  preview,
  onOpenStep,
}: {
  preview: ExecutionPreview;
  onOpenStep: (stepIndex: number) => void;
}) {
  const suiteDefaults = preview.suiteDefaultEvaluators;
  return (
    <>
      {preview.leadingAssertions.length > 0 && (
        <AssertionList
          assertions={preview.leadingAssertions}
          onOpenStep={onOpenStep}
        />
      )}
      {preview.steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">This case has no steps.</p>
      ) : (
        <ol className="space-y-2">
          {preview.steps.map((editorStep) => {
            const detail = stepDetail(editorStep);
            return (
              <li key={editorStep.step.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open step ${editorStep.ordinal} in the test case`}
                  onClick={() => onOpenStep(editorStep.index)}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] tabular-nums">
                    {editorStep.ordinal}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">
                      Step {editorStep.ordinal} · {editorStep.label}
                    </span>
                    {detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {detail}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                </button>
                {editorStep.assertions.length > 0 && (
                  <div className="ml-7">
                    <AssertionList
                      assertions={editorStep.assertions}
                      onOpenStep={onOpenStep}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {preview.afterRunAssertions.assertions.length > 0 && (
        <div className="space-y-1">
          <div className={sectionLabel}>{preview.afterRunAssertions.label}</div>
          <p className="text-xs">
            {describePredicates(preview.afterRunAssertions.assertions)}
          </p>
        </div>
      )}
      {preview.expectedOutcome && (
        <div className="space-y-1">
          <div className={`${sectionLabel} flex items-center gap-1`}>
            <Flag aria-hidden="true" className="size-3" />
            Expected outcome
          </div>
          <p className="text-xs">{preview.expectedOutcome}</p>
        </div>
      )}
      <div className="space-y-1 border-t border-border pt-3">
        <div className={sectionLabel}>Suite default evaluators</div>
        <p className="text-xs text-muted-foreground">
          {suiteDefaults.assertions.length > 0
            ? describePredicates(suiteDefaults.assertions)
            : suiteDefaults.replacedCount > 0
              ? `This case replaces the suite's ${suiteDefaults.replacedCount} defaults.`
              : "None"}
        </p>
      </div>
    </>
  );
}

function AssertionList({
  assertions,
  onOpenStep,
}: {
  assertions: readonly EditorAssertion[];
  onOpenStep: (stepIndex: number) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {assertions.map(({ step, index }) => (
        <li key={step.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpenStep(index)}
          >
            <Diamond
              aria-hidden="true"
              className="size-3 shrink-0 text-success"
            />
            <span className="min-w-0 truncate">
              {assertionLabel(step.assertion)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
