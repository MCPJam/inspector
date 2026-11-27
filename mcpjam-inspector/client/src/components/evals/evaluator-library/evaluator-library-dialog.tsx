import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
import { ArrowLeft, Library } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { formatCriterion } from "@/shared/predicate-kinds";
import { CUSTOM_JUDGE_COST_COPY } from "./custom-judges-model";
import {
  EvaluatorLibraryBrowse,
  type LibraryFilters,
} from "./evaluator-library-browse";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import {
  isAuthorable,
  isInSuite,
  judgesWithAdded,
  LIBRARY_EVALUATORS,
  missingParts,
  questionsWithAdded,
  taggedJudges,
  taggedQuestions,
  type LibraryAddition,
  type LibraryEvaluator,
  type LibrarySuiteParts,
  type LibrarySupport,
} from "./library-catalog";

type LibraryProps = {
  suite: LibrarySuiteParts;
  support: LibrarySupport;
  /** Saves the addition, or says why it could not. */
  onAdd: (addition: LibraryAddition) => string | undefined;
  /** The backend's `judges.custom.maxJudges`. */
  judgeLimit: number;
};

const DEFAULT_FILTERS: LibraryFilters = { category: "all", search: "" };

/**
 * Opens the evaluator library from suite settings. Adding an evaluator hands
 * what the suite does not have yet to `onAdd`, which saves it like "Add
 * assertion" does. Renders nothing unless the evaluator-library flag is on
 * and this deployment can add a preset or author an evaluator.
 */
export function EvaluatorLibraryButton(props: LibraryProps) {
  const enabled = useEvaluatorLibraryEnabled();
  const anyAuthorable = LIBRARY_EVALUATORS.some((e) =>
    isAuthorable(e, props.support),
  );
  if (!enabled || !anyAuthorable) return null;
  return <EvaluatorLibraryDialog {...props} />;
}

function EvaluatorLibraryDialog({
  suite,
  support,
  onAdd,
  judgeLimit,
}: LibraryProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const available = LIBRARY_EVALUATORS.filter((e) => isAuthorable(e, support));
  const selected = available.find((e) => e.id === selectedId);
  const browsing = !selected;
  const goBack = () => setSelectedId(null);
  const backButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="-ml-2 w-fit"
      onClick={goBack}
    >
      <ArrowLeft aria-hidden />
      Back to library
    </Button>
  );
  const show = (id: string) => {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement ? focused : null;
    setSelectedId(id);
  };
  useLayoutEffect(() => {
    if (!open) return;
    if (browsing) {
      returnFocus.current?.focus({ preventScroll: true });
      returnFocus.current = null;
    } else {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [browsing, open]);
  // The same checks the suite edit makes, so Add is never offered for an
  // edit that would be refused.
  const getAddDisabledReason = (evaluator: LibraryEvaluator) => {
    const { questions, judges } = missingParts(evaluator, suite);
    return (
      questionsWithAdded(suite.questions ?? [], questions).refused ??
      judgesWithAdded(suite.judges ?? [], judges, judgeLimit).refused
    );
  };
  const add = (evaluator: LibraryEvaluator) => {
    if (!getAddDisabledReason(evaluator)) onAdd(missingParts(evaluator, suite));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSelectedId(null);
          setFilters(DEFAULT_FILTERS);
          returnFocus.current = null;
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Library aria-hidden />
          From library
        </Button>
      </DialogTrigger>
      <DialogContent
        className="h-[48rem] max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[58rem]"
        onEscapeKeyDown={(event) => {
          // Escape steps back to the library before it closes the dialog.
          if (browsing) return;
          event.preventDefault();
          goBack();
        }}
      >
        <DialogHeader className="gap-1 border-b border-border px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12">
          <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
            {selected?.name ?? "Evaluator library"}
          </DialogTitle>
          <DialogDescription>
            {selected?.question ?? "Choose what to check on each iteration."}
          </DialogDescription>
        </DialogHeader>
        <div className={browsing ? "grid min-h-0" : "hidden"}>
          <EvaluatorLibraryBrowse
            evaluators={available}
            suite={suite}
            filters={filters}
            onFiltersChange={setFilters}
            onOpen={show}
            onAdd={add}
            getAddDisabledReason={getAddDisabledReason}
          />
        </div>
        {selected ? (
          <div
            key={selected.id}
            className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5"
          >
            {backButton}
            <EvaluatorDetail
              evaluator={selected}
              inSuite={isInSuite(selected, suite)}
              onAdd={() => add(selected)}
              addDisabledReason={getAddDisabledReason(selected)}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EvaluatorDetail({
  evaluator,
  inSuite,
  onAdd,
  addDisabledReason,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  onAdd: () => void;
  addDisabledReason?: string;
}) {
  const reasonId = useId();
  const showReason = addDisabledReason && !inSuite;
  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="What this evaluator adds"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {taggedQuestions(evaluator).map((q) => (
          <li
            key={q.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
          >
            <span>
              {q.label}
              <span className="block text-xs text-muted-foreground">
                Yes/no question, passes on{" "}
                {q.pass.answer === "yes" ? "Yes" : "No"}. Asked with the
                goal-completion judge.
              </span>
            </span>
            <span className="text-xs text-muted-foreground">Advisory</span>
          </li>
        ))}
        {taggedJudges(evaluator).map((j) => (
          <li
            key={j.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
          >
            <span>
              {j.label}
              <span className="block text-xs text-muted-foreground">
                {j.output.kind === "score"
                  ? `Judge prompt, passes at a score of ${j.output.threshold} or more.`
                  : "Judge prompt, pass or fail."}{" "}
                {CUSTOM_JUDGE_COST_COPY}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">Advisory</span>
          </li>
        ))}
        {evaluator.checks.map((check) => (
          <li
            key={check.type}
            className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
          >
            {formatCriterion({ predicate: check })}
            <span className="text-xs text-muted-foreground">
              {check.role === "advisory" ? "Advisory" : "Required"}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {showReason ? (
          <p id={reasonId} className="text-sm text-muted-foreground">
            {addDisabledReason}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={onAdd}
          aria-describedby={showReason ? reasonId : undefined}
          disabled={inSuite || Boolean(addDisabledReason)}
        >
          {inSuite ? "In this suite" : "Add to suite"}
        </Button>
      </div>
    </div>
  );
}
