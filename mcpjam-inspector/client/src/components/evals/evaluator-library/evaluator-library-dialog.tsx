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
  missingChecks,
  type LibraryEvaluator,
} from "./library-catalog";

/**
 * Opens the evaluator library from suite settings. Adding an evaluator hands
 * its checks to `onAdd`, which saves them like "Add assertion" does. Renders
 * nothing unless the evaluator-library flag is on and this deployment can
 * save at least one library evaluator.
 */
export function EvaluatorLibraryButton({
  predicates,
  authorableKinds,
  onAdd,
}: {
  predicates: readonly Predicate[];
  authorableKinds?: readonly Predicate["type"][];
  onAdd: (checks: readonly Predicate[]) => void;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  const anyAuthorable = LIBRARY_EVALUATORS.some((e) =>
    isAuthorable(e, authorableKinds),
  );
  if (!enabled || !anyAuthorable) return null;
  return (
    <EvaluatorLibraryDialog
      predicates={predicates}
      authorableKinds={authorableKinds}
      onAdd={onAdd}
    />
  );
}

export function EvaluatorLibraryDialog({
  predicates,
  authorableKinds,
  onAdd,
}: {
  predicates: readonly Predicate[];
  authorableKinds?: readonly Predicate["type"][];
  onAdd: (checks: readonly Predicate[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const available = LIBRARY_EVALUATORS.filter((e) =>
    isAuthorable(e, authorableKinds),
  );
  const selected = available.find((e) => e.id === selectedId);
  const add = (evaluator: LibraryEvaluator) => {
    onAdd(missingChecks(evaluator, predicates));
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
            inSuite={isInSuite(selected, predicates)}
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
                inSuite={isInSuite(evaluator, predicates)}
                onOpen={() => setSelectedId(evaluator.id)}
                onAdd={() => add(evaluator)}
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
  onBack,
  onAdd,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Assertions this evaluator adds"
        className="divide-y divide-border rounded-lg border border-border"
      >
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
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden />
          All evaluators
        </Button>
        <Button type="button" onClick={onAdd} disabled={inSuite}>
          {inSuite ? "In this suite" : "Add to suite"}
        </Button>
      </div>
    </div>
  );
}
