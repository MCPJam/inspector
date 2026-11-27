/** One recorded problem and its recommended next step; copy stays with its finding. */
import { useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import type { FindingProblem } from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { AffectedIterationRow } from "./affected-iterations-list";
import { FindingText } from "./finding-text";
import {
  OPTION_KIND_LABEL,
  optionTargetLabel,
  plural,
} from "./problem-prompts";
import {
  coverageLine,
  CopyOptionPrompt,
  ProblemDetailsContent,
} from "./problem-details";
import { ProblemRubric } from "./problem-rubric";

export function ProblemSummary({
  problem,
  lead = false,
  context,
  onOpenEvidence,
  iterationRows = {},
  caveat = null,
}: {
  problem: FindingProblem;
  caveat?: string | null;
  lead?: boolean;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const option = problem.options[0];
  const target = option ? optionTargetLabel(option) : null;
  const openEvidence = onOpenEvidence
    ? (locator: FindingEvidenceLocator) => {
        trigger.current = null;
        setOpen(false);
        onOpenEvidence(locator);
      }
    : undefined;
  return (
    <article data-testid={lead ? "problem-lead" : "problem"}>
      <div className="max-w-4xl text-sm leading-relaxed">
        <ul className="list-disc space-y-2 pl-5 [&>li]:break-words">
          <ProblemRubric problem={problem} iterationRows={iterationRows} />
          <li>
            <details>
              <summary className="cursor-pointer">
                <strong>Evidence:</strong> {problem.affected.count} of{" "}
                {plural(problem.affected.total, "iteration")} affected. View
                recorded result
              </summary>
              <p className="mt-2">
                <FindingText text={problem.observed} />
              </p>
            </details>
          </li>
          {option ? (
            <>
              <li>
                <strong>{OPTION_KIND_LABEL[option.kind]}:</strong>{" "}
                <FindingText text={option.change} />
              </li>
              <li>
                <strong>Why:</strong>{" "}
                <FindingText
                  text={problem.recommendationReason ?? option.rationale}
                />
              </li>
              <li>
                <strong>Success check:</strong>{" "}
                <FindingText text={option.verification} />
              </li>
            </>
          ) : (
            <li>
              <strong>Next:</strong> No action is available for this problem
              yet.
            </li>
          )}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          {coverageLine(problem)}
        </p>
        {target ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {target} · not yet verified
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setOpen(true);
            }}
            data-testid="problem-details-toggle"
          >
            {problem.options.length > 1
              ? `See ${problem.options.length} options`
              : "See details"}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </button>
          {option ? (
            <CopyOptionPrompt problem={problem} option={option} context={context} />
          ) : null}
        </div>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          className="w-full gap-0 overflow-y-auto sm:max-w-[620px] [&>button]:z-20"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <SheetHeader className="sticky top-0 z-10 bg-background px-6 pt-6 pr-12 pb-5">
            <SheetTitle className="text-lg">Problem details</SheetTitle>
            <SheetDescription>
              <FindingText text={problem.title} />
            </SheetDescription>
          </SheetHeader>
          <ProblemDetailsContent
            problem={problem}
            context={context}
            iterationRows={iterationRows}
            caveat={caveat}
            onOpenEvidence={openEvidence}
          />
        </SheetContent>
      </Sheet>
    </article>
  );
}
