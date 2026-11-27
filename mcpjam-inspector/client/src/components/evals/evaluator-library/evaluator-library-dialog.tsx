import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import { ArrowLeft, Library } from "lucide-react";
import { useState } from "react";
import { formatCriterion } from "@/shared/predicate-kinds";
import { EvaluatorCard } from "./evaluator-card";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import {
  builtFrom,
  isAuthorable,
  isInSuite,
  LIBRARY_EVALUATORS,
  questionsWithAdded,
  taggedChecks,
  taggedQuestions,
  type LibraryEvaluator,
} from "./library-catalog";

type LibraryProps = {
  predicates: readonly Predicate[];
  /** The suite's rubric-check questions, to mark evaluators already added. */
  questions?: readonly RubricCheckQuestion[];
  authorableKinds?: readonly Predicate["type"][];
  /** Whether this deployment accepts yes/no rubric-check questions. */
  canAskYesNo?: boolean;
  onAdd: (
    checks: readonly Predicate[],
    questions: readonly RubricCheckQuestion[],
  ) => void;
};

export function EvaluatorLibraryButton(props: LibraryProps) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) return null;
  const available = LIBRARY_EVALUATORS.filter((e) =>
    isAuthorable(e, props.authorableKinds, props.canAskYesNo),
  );
  if (available.length === 0) return null;
  return <EvaluatorLibraryDialog {...props} available={available} />;
}

function EvaluatorLibraryDialog({
  predicates,
  questions = [],
  onAdd,
  available,
}: Omit<LibraryProps, "authorableKinds" | "canAskYesNo"> & {
  available: readonly LibraryEvaluator[];
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = available.find((e) => e.id === selectedId);
  // The same check the suite edit makes, so Add is never offered for an
  // edit that would be refused.
  const reasonAddDisabled = (evaluator: LibraryEvaluator) =>
    questionsWithAdded(questions, taggedQuestions(evaluator)).refused;
  const add = (evaluator: LibraryEvaluator) => {
    if (reasonAddDisabled(evaluator)) return;
    onAdd(taggedChecks(evaluator), taggedQuestions(evaluator));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelectedId(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Library aria-hidden />
          From library
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {selected ? selected.name : "Evaluator library"}
          </DialogTitle>
          <DialogDescription>
            {selected
              ? selected.question
              : "Each evaluator adds a set of assertions to this suite. You can change or remove them afterwards like any other assertion."}
          </DialogDescription>
        </DialogHeader>
        {selected ? (
          <EvaluatorDetail
            evaluator={selected}
            inSuite={isInSuite(selected, predicates, questions)}
            reasonAddDisabled={reasonAddDisabled(selected)}
            onBack={() => setSelectedId(null)}
            onAdd={() => add(selected)}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {available.map((evaluator) => (
              <EvaluatorCard
                key={evaluator.id}
                name={evaluator.name}
                question={evaluator.question}
                icon={evaluator.icon}
                tone={evaluator.tone}
                builtFrom={builtFrom(evaluator)}
                inSuite={isInSuite(evaluator, predicates, questions)}
                onOpen={() => setSelectedId(evaluator.id)}
                onAdd={
                  !reasonAddDisabled(evaluator)
                    ? () => add(evaluator)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EvaluatorDetail({
  evaluator,
  inSuite,
  reasonAddDisabled,
  onBack,
  onAdd,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  reasonAddDisabled: string | undefined;
  onBack: () => void;
  onAdd: () => void;
}) {
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
      {!inSuite && reasonAddDisabled ? (
        <p className="text-sm text-muted-foreground">{reasonAddDisabled}</p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden />
          All evaluators
        </Button>
        <Button
          type="button"
          onClick={onAdd}
          disabled={inSuite || Boolean(reasonAddDisabled)}
        >
          {inSuite ? "In this suite" : "Add to suite"}
        </Button>
      </div>
    </div>
  );
}
