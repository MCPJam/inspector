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
import { useState } from "react";
import {
  MAX_CUSTOM_JUDGES,
  MAX_RUBRIC_CHECK_QUESTIONS,
} from "@/components/shared/session-quality/judge-config";
import { formatCriterion } from "@/shared/predicate-kinds";
import { EvaluatorCard } from "./evaluator-card";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import {
  builtFrom,
  hasLibraryIdConflict,
  isAuthorable,
  isInSuite,
  LIBRARY_EVALUATORS,
  missingParts,
  taggedJudges,
  taggedQuestions,
  type LibraryAddition,
  type LibraryEvaluator,
  type LibrarySuiteParts,
  type LibrarySupport,
} from "./library-catalog";

export function EvaluatorLibraryButton({
  suite,
  support,
  onAdd,
  judgeLimit,
}: {
  suite: LibrarySuiteParts;
  support: LibrarySupport;
  onAdd: (addition: LibraryAddition) => void;
  judgeLimit?: number;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  const anyAuthorable = LIBRARY_EVALUATORS.some((e) => isAuthorable(e, support));
  if (!enabled || !anyAuthorable) return null;
  return (
    <EvaluatorLibraryDialog
      suite={suite}
      support={support}
      onAdd={onAdd}
      judgeLimit={judgeLimit}
    />
  );
}

export function EvaluatorLibraryDialog({
  suite,
  support,
  onAdd,
  judgeLimit = MAX_CUSTOM_JUDGES,
}: {
  suite: LibrarySuiteParts;
  support: LibrarySupport;
  onAdd: (addition: LibraryAddition) => void;
  judgeLimit?: number;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const available = LIBRARY_EVALUATORS.filter((e) => isAuthorable(e, support));
  const selected = available.find((e) => e.id === selectedId);
  const blockedReason = (evaluator: LibraryEvaluator) => {
    if (hasLibraryIdConflict(evaluator, suite)) {
      return "A question or judge already uses this preset's ID. Remove it to add the preset.";
    }
    const { judges, questions } = missingParts(evaluator, suite);
    if (
      questions.length > 0 &&
      (suite.questions?.length ?? 0) + questions.length > MAX_RUBRIC_CHECK_QUESTIONS
    ) {
      return `This suite already has ${MAX_RUBRIC_CHECK_QUESTIONS} rubric-check questions. Remove one to add this evaluator.`;
    }
    if (judges.length > 0 && (suite.judges?.length ?? 0) + judges.length > judgeLimit) {
      return `Remove a judge to add this preset. Each suite can have ${judgeLimit} judges.`;
    }
  };
  const add = (evaluator: LibraryEvaluator) => {
    if (!blockedReason(evaluator)) onAdd(missingParts(evaluator, suite));
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
              : "Each evaluator adds assertions, questions or judges to this suite. You can change or remove them afterwards."}
          </DialogDescription>
        </DialogHeader>
        {selected ? (
          <EvaluatorDetail
            evaluator={selected}
            inSuite={isInSuite(selected, suite)}
            addDisabledReason={blockedReason(selected)}
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
                inSuite={isInSuite(evaluator, suite)}
                onOpen={() => setSelectedId(evaluator.id)}
                onAdd={blockedReason(evaluator) ? undefined : () => add(evaluator)}
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
  addDisabledReason,
  onBack,
  onAdd,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  addDisabledReason?: string;
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
                Runs with the goal-completion judge.
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
      {!inSuite && addDisabledReason ? (
        <p className="text-sm text-muted-foreground">{addDisabledReason}</p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden />
          All evaluators
        </Button>
        <Button type="button" onClick={onAdd} disabled={inSuite || Boolean(addDisabledReason)}>
          {inSuite ? "In this suite" : "Add to suite"}
        </Button>
      </div>
    </div>
  );
}
