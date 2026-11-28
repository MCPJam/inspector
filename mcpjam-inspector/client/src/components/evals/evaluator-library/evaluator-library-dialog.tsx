import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
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
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatCriterion } from "@/shared/predicate-kinds";
import { CUSTOM_JUDGE_COST_COPY } from "./custom-judges-model";
import {
  EvaluatorLibraryBrowse,
  type LibraryFilters,
  type MethodAvailability,
} from "./evaluator-library-browse";
import type { EvaluatorMethod } from "./evaluator-library-types";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { EVALUATOR_METHODS } from "./evaluator-methods";
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

/** What a Method card's editor can tell the dialog. */
type MethodEditorActions = {
  /** Back to the library; `saved` says the draft went into the suite draft. */
  close: (saved: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
};

type LibraryProps = {
  suite: LibrarySuiteParts;
  support: LibrarySupport;
  /** Saves the addition, or says why it could not. */
  onAdd: (addition: LibraryAddition) => string | undefined;
  /** The backend's `judges.custom.maxJudges`. */
  judgeLimit: number;
  /** Why the suite will not run the questions or judges a preset adds. */
  pause: { questions?: string; judges?: string };
  authoring: {
    methods: MethodAvailability;
    render: (
      method: EvaluatorMethod,
      actions: MethodEditorActions,
    ) => ReactNode;
  };
};

type LibraryView =
  { type: "preset"; id: string } | { type: "method"; method: EvaluatorMethod };

const DEFAULT_FILTERS: LibraryFilters = { category: "all", search: "" };

const SAVED_STATUS = "Added to your unsaved changes. Save settings to keep it.";

/**
 * Opens the evaluator library from suite settings. Adding an evaluator hands
 * what the suite does not have yet to `onAdd`, which saves it like "Add
 * assertion" does. Renders nothing unless the evaluator-library flag is on
 * and this deployment can add a preset or author an evaluator.
 */
export function EvaluatorLibraryButton(props: LibraryProps) {
  const enabled = useEvaluatorLibraryEnabled();
  const anyAuthorable =
    LIBRARY_EVALUATORS.some((e) => isAuthorable(e, props.support)) ||
    Object.values(props.authoring.methods).some((reason) => reason === null);
  if (!enabled || !anyAuthorable) return null;
  return <EvaluatorLibraryDialog {...props} />;
}

function EvaluatorLibraryDialog({
  suite,
  support,
  onAdd,
  judgeLimit,
  pause,
  authoring,
}: LibraryProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [view, setView] = useState<LibraryView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // The leave a changed draft is waiting on: back to the library, or closed.
  const [pendingLeave, setPendingLeave] = useState<"back" | "close" | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const available = LIBRARY_EVALUATORS.filter((e) => isAuthorable(e, support));
  const selected =
    view?.type === "preset"
      ? available.find((e) => e.id === view.id)
      : undefined;
  const method =
    view?.type === "method"
      ? EVALUATOR_METHODS.find((item) => item.value === view.method)
      : undefined;
  const browsing = !selected && !method;
  const goBack = () => {
    setDirty(false);
    setView(null);
  };
  const leave = (to: "back" | "close") => {
    if (to === "back") goBack();
    else {
      setDirty(false);
      setOpen(false);
    }
  };
  // A changed Method-card draft is never dropped without asking.
  const requestLeave = (to: "back" | "close") => {
    if (method && dirty) setPendingLeave(to);
    else leave(to);
  };
  const backButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="col-span-full -ml-2 w-fit"
      onClick={() => requestLeave("back")}
    >
      <ArrowLeft aria-hidden />
      Back to library
    </Button>
  );
  const show = (next: LibraryView) => {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement ? focused : null;
    setStatus(null);
    setView(next);
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
        if (!next) {
          requestLeave("close");
          return;
        }
        setOpen(true);
        setView(null);
        setDirty(false);
        setStatus(null);
        setFilters(DEFAULT_FILTERS);
        returnFocus.current = null;
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Library aria-hidden />
          From library
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0",
          method ? "sm:max-w-2xl" : "h-[48rem] sm:max-w-[58rem]",
        )}
        onEscapeKeyDown={(event) => {
          // Escape steps back to the library before it closes the dialog.
          if (browsing) return;
          event.preventDefault();
          requestLeave("back");
        }}
      >
        <DialogHeader
          className={cn(
            "gap-1 border-b border-border px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12",
            method &&
              "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3",
          )}
        >
          {method ? backButton : null}
          {method ? (
            <span
              className={cn(
                "row-span-2 grid size-9 place-items-center rounded-md",
                method.tone,
              )}
            >
              <method.icon aria-hidden className="size-4" />
            </span>
          ) : null}
          <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
            {selected?.name ?? method?.title ?? "Evaluator library"}
          </DialogTitle>
          <DialogDescription>
            {selected?.question ??
              method?.description ??
              "Choose what to check on each iteration."}
          </DialogDescription>
          {/* In the header, which never hides, so the confirmation is read
              out after an editor closes. */}
          <p
            aria-live="polite"
            className="col-span-full text-sm text-muted-foreground empty:hidden"
          >
            {status}
          </p>
        </DialogHeader>
        <div className={browsing ? "grid min-h-0" : "hidden"}>
          <EvaluatorLibraryBrowse
            evaluators={available}
            suite={suite}
            filters={filters}
            onFiltersChange={setFilters}
            methods={authoring.methods}
            onMethod={(method) => show({ type: "method", method })}
            onOpen={(id) => show({ type: "preset", id })}
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
              pause={pause}
              onAdd={() => add(selected)}
              addDisabledReason={getAddDisabledReason(selected)}
            />
          </div>
        ) : method ? (
          authoring.methods[method.value] !== null ? (
            <p
              role="status"
              className="p-4 text-sm text-muted-foreground sm:p-5"
            >
              {authoring.methods[method.value]}
            </p>
          ) : (
            authoring.render(method.value, {
              close: (saved) => {
                goBack();
                if (saved) setStatus(SAVED_STATUS);
              },
              onDirtyChange: setDirty,
            })
          )
        ) : null}
      </DialogContent>
      <AlertDialog
        open={pendingLeave !== null}
        onOpenChange={(next) => {
          if (!next) setPendingLeave(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              It has not been added to the suite yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingLeave) leave(pendingLeave);
                setPendingLeave(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function EvaluatorDetail({
  evaluator,
  inSuite,
  pause,
  onAdd,
  addDisabledReason,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  pause: LibraryProps["pause"];
  onAdd: () => void;
  addDisabledReason?: string;
}) {
  const reasonId = useId();
  const showReason = addDisabledReason && !inSuite;
  const notes = [
    evaluator.questions?.length ? pause.questions : undefined,
    evaluator.judges?.length ? pause.judges : undefined,
  ].filter((note): note is string => Boolean(note));
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
      {notes.map((note) => (
        <p key={note} role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
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
