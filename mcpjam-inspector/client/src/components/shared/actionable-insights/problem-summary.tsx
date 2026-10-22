/** One recorded problem and its recommended next step; copy lives in the panel header. */
import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  FlaskConical,
  Search,
  Wrench,
} from "lucide-react";
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
import { OPTION_KIND_LABEL, optionTargetLabel } from "./problem-prompts";
import { coverageLine, ProblemDetailsContent } from "./problem-details";

const KIND_ICON = {
  fix: Wrench,
  experiment: FlaskConical,
  investigation: Search,
};

export function ProblemSummary({
  problem,
  lead = false,
  context,
  onOpenEvidence,
  iterationRows = {},
}: {
  problem: FindingProblem;
  lead?: boolean;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const option = problem.options[0];
  const Icon = option ? KIND_ICON[option.kind] : Search;
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
      <div className="grid grid-cols-1 md:grid-cols-2">
        <section className="min-w-0 pb-5 md:pr-7 md:pb-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            What happened
          </h4>
          <p className="mt-3 break-words text-[15px] leading-7">
            <FindingText text={problem.observed} />
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {coverageLine(problem)}
          </p>
        </section>
        <section className="min-w-0 border-t border-border/60 pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-7">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {option ? OPTION_KIND_LABEL[option.kind] : "No supported next step"}
          </h4>
          {option ? (
            <>
              <p className="mt-3 break-words text-[15px] leading-7">
                <FindingText text={option.change} />
              </p>
              <p className="mt-3 text-sm leading-relaxed">
                <span className="font-semibold">Why: </span>
                {problem.recommendationReason ?? (
                  <FindingText text={option.rationale} />
                )}
              </p>
              {target ? (
                <p className="mt-2 break-words text-xs text-muted-foreground">
                  {target} · not yet verified
                </p>
              ) : null}
            </>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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
          </div>
        </section>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          className="w-full gap-0 overflow-y-auto sm:max-w-[620px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <SheetHeader className="sticky top-0 z-10 bg-background px-6 pt-6 pr-12 pb-5">
            <SheetTitle className="text-lg">Problem details</SheetTitle>
            <SheetDescription>
              {option ? OPTION_KIND_LABEL[option.kind] : problem.title}
            </SheetDescription>
          </SheetHeader>
          <ProblemDetailsContent
            problem={problem}
            context={context}
            iterationRows={iterationRows}
            onOpenEvidence={openEvidence}
          />
        </SheetContent>
      </Sheet>
    </article>
  );
}
