import { Button } from "@mcpjam/design-system/button";
import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import { formatCriterion } from "@/shared/predicate-kinds";
import { RoleChip } from "../scorer-role-control";
import {
  roleOfPredicate,
  type ScorerUiRole,
} from "../suite-scorer-table-model";
import {
  CUSTOM_JUDGE_COST_COPY,
  judgePromptVariables,
} from "./custom-judges-model";
import { EvaluatorDialogLayout } from "./evaluator-editor-layout";
import {
  taggedJudges,
  taggedQuestions,
  type LibraryEvaluator,
} from "./library-catalog";
import { usedVariables } from "./prompt-editor";
import { VariableMappingTable } from "./variable-mapping-table";

export function EvaluatorPresetDetails({
  evaluator,
  inSuite,
  pause,
  onAdd,
  addDisabledReason,
}: {
  evaluator: LibraryEvaluator;
  inSuite: boolean;
  pause: { questions?: string; judges?: string };
  onAdd: () => void;
  addDisabledReason?: string;
}) {
  const reasonId = useId();
  const showReason = addDisabledReason && !inSuite;
  const questions = taggedQuestions(evaluator);
  const judges = taggedJudges(evaluator);
  const notes = [
    questions.length ? pause.questions : undefined,
    judges.length ? pause.judges : undefined,
  ].filter((note): note is string => Boolean(note));

  return (
    <EvaluatorDialogLayout
      notice={
        showReason ? (
          <p id={reasonId} className="text-sm text-muted-foreground">
            {addDisabledReason}
          </p>
        ) : null
      }
      footer={
        inSuite ? (
          <p role="status" className="ml-auto flex items-center gap-1.5 text-sm">
            <Check aria-hidden className="size-4" />
            In this suite
          </p>
        ) : (
          <>
            {!showReason ? (
              <span className="text-xs text-muted-foreground">
                Adds to your unsaved suite changes.
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={onAdd}
              aria-describedby={showReason ? reasonId : undefined}
              disabled={Boolean(addDisabledReason)}
            >
              Add to suite
            </Button>
          </>
        )
      }
    >
      <p className="max-w-prose text-sm text-foreground">{evaluator.useCase}</p>
      {notes.map((note) => (
        <p key={note} role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">What this adds</h3>
        <ul
          aria-label="What this evaluator adds"
          className="divide-y divide-border rounded-lg border border-border"
        >
          {evaluator.checks.map((check) => (
            <PresetPart
              key={check.type}
              label={formatCriterion({ predicate: check })}
              role={roleOfPredicate(check)}
            />
          ))}
          {questions.map((question) => (
            <PresetPart key={question.id} label={question.label} role="advisory">
              <p className="text-xs text-muted-foreground">
                Yes/no question. Passes on{" "}
                {question.pass.answer === "yes" ? "Yes" : "No"}. Asked with the
                goal-completion judge.
              </p>
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium">Question instructions</h4>
                <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  {question.instructions}
                </p>
              </div>
            </PresetPart>
          ))}
          {judges.map((judge) => (
            <PresetPart key={judge.id} label={judge.label} role="advisory">
              <p className="text-xs text-muted-foreground">
                {judge.output.kind === "score"
                  ? `Scores from 0 to 1. Passes at ${judge.output.threshold} or higher.`
                  : "Returns pass or fail."}{" "}
                {CUSTOM_JUDGE_COST_COPY}
              </p>
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium">Judge prompt</h4>
                <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs break-words text-foreground">
                  {judge.prompt}
                </pre>
              </div>
              <VariableMappingTable
                variables={judgePromptVariables(usedVariables(judge.prompt))}
              />
            </PresetPart>
          ))}
        </ul>
      </div>
    </EvaluatorDialogLayout>
  );
}

function PresetPart({
  label,
  role,
  children,
}: {
  label: string;
  role: ScorerUiRole;
  children?: ReactNode;
}) {
  return (
    <li className="space-y-2.5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span>{label}</span>
        <RoleChip role={role} />
      </div>
      {children}
    </li>
  );
}
