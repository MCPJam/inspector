import { cn } from "@mcpjam/design-system/cn";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { useId, useState } from "react";
import { SCRIPT_TEXT_CLASS } from "../code-grading/setup-cleanup-row";
import type { SuiteScripts } from "../code-grading/code-grading-values";
import { RoleSegmentGroup } from "../scorer-role-control";
import {
  codeEvaluatorIdFor,
  codeEvaluatorProblems,
  codeLanguageOf,
  draftOfCodeEvaluator,
  toCodeEvaluator,
  type CodeEvaluator,
  type CodeEvaluatorDraft,
} from "./code-evaluator-model";
import { CodeEvaluatorStarterPicker } from "./code-evaluator-starter-picker";
import { draftChanged, EvaluatorEditorLayout } from "./evaluator-editor-layout";

/** What each role means, in the words the scorer tables use. */
const ROLE_MEANING = {
  required:
    "If this evaluator fails, the iteration fails. If it errors, the iteration is left out of the pass rate.",
  advisory: "Shown on the result. Never fails the iteration.",
} as const;

/**
 * Writes or edits one code evaluator, in the library dialog or inline in
 * suite settings. `requiredRefusal` says why Required isn't offered.
 */
export function CodeEvaluatorEditor({
  inDialog = false,
  evaluator,
  others,
  scripts,
  requiredRefusal,
  onCancel,
  onSave,
  onDirtyChange,
}: {
  inDialog?: boolean;
  /** The evaluator being edited; absent for a new one. */
  evaluator?: CodeEvaluator;
  /** The suite's other code evaluators: their IDs and sizes count. */
  others: readonly CodeEvaluator[];
  scripts: SuiteScripts | undefined;
  requiredRefusal?: string;
  onCancel: () => void;
  /** Saves the evaluator, or says why the suite refused it. */
  onSave: (evaluator: CodeEvaluator) => string | undefined;
  /** The dialog asks before closing over a changed draft. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const [start] = useState(() => draftOfCodeEvaluator(evaluator));
  const [draft, setDraftState] = useState(start);
  const setDraft = (next: CodeEvaluatorDraft) => {
    setDraftState(next);
    onDirtyChange?.(draftChanged(next, start));
  };
  const [tried, setTried] = useState(false);
  // Why the suite refused the save, when the draft itself was fine.
  const [refusal, setRefusal] = useState<string>();
  const problems = codeEvaluatorProblems(draft, others, scripts);
  const problem =
    problems.name ?? problems.fileName ?? problems.script ?? problems.threshold;
  const language = codeLanguageOf(draft.fileName);
  // A file name is checked as it is typed; an empty field waits for Add.
  const fileNameHint =
    tried || draft.fileName.trim() ? problems.fileName : undefined;
  const save = () => {
    setTried(true);
    if (problem) return;
    // A new evaluator's ID comes from its file name and never changes after.
    const identity = evaluator ?? {
      id: codeEvaluatorIdFor(
        draft.fileName,
        others.map((other) => other.id),
      ),
    };
    setRefusal(onSave(toCodeEvaluator(draft, identity)));
  };
  const field = (name: string) => `${id}-${name}`;

  return (
    <EvaluatorEditorLayout
      inDialog={inDialog}
      inlineClassName="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3"
      action={evaluator ? "Save" : "Add evaluator"}
      error={tried ? (problem ?? refusal) : undefined}
      onCancel={onCancel}
      onSubmit={save}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={field("name")}>Name</Label>
        <Input
          id={field("name")}
          value={draft.name}
          maxLength={100}
          placeholder="Calls each tool once"
          aria-invalid={tried && problems.name ? true : undefined}
          aria-describedby={
            tried && problems.name ? field("name-hint") : undefined
          }
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <FieldError id={field("name-hint")} className="text-xs">
          {tried ? problems.name : undefined}
        </FieldError>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={field("script")}>Script</Label>
          <CodeEvaluatorStarterPicker
            fileName={draft.fileName}
            script={draft.script}
            language={language}
            onPick={(picked) => setDraft({ ...draft, ...picked })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Input
            id={field("file")}
            aria-label="File name"
            value={draft.fileName}
            placeholder="check.py"
            spellCheck={false}
            className={cn(SCRIPT_TEXT_CLASS, "h-9 w-56 max-w-full")}
            aria-invalid={fileNameHint ? true : undefined}
            aria-describedby={field("file-hint")}
            onChange={(event) =>
              setDraft({ ...draft, fileName: event.target.value })
            }
          />
          {fileNameHint ? null : (
            <span
              id={field("file-hint")}
              className="text-xs text-muted-foreground"
            >
              {language ? `Runs as ${language}` : null}
            </span>
          )}
        </div>
        <FieldError id={field("file-hint")} className="text-xs">
          {fileNameHint}
        </FieldError>
        <Textarea
          id={field("script")}
          value={draft.script}
          spellCheck={false}
          placeholder="Pick a starter, or write a script that reads $MCPJAM_ITERATION and writes a score to $MCPJAM_RESULT."
          aria-invalid={tried && problems.script ? true : undefined}
          aria-describedby={problems.script ? field("script-hint") : undefined}
          onChange={(event) =>
            setDraft({ ...draft, script: event.target.value })
          }
          className={cn(SCRIPT_TEXT_CLASS, "min-h-64 resize-y")}
        />
        <FieldError id={field("script-hint")} className="text-xs">
          {tried || draft.script.trim() ? problems.script : undefined}
        </FieldError>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Role</span>
          <RoleSegmentGroup
            value={draft.role}
            ariaLabel="Evaluator role"
            disabledRoles={requiredRefusal ? ["required"] : undefined}
            onChange={(role) => setDraft({ ...draft, role })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {ROLE_MEANING[draft.role]}
        </p>
        {requiredRefusal ? (
          <p role="status" className="text-xs text-muted-foreground">
            {requiredRefusal}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={field("threshold")}>Passing score</Label>
          <Input
            id={field("threshold")}
            type="number"
            className="w-24"
            min={0.05}
            max={1}
            step={0.05}
            value={draft.threshold}
            aria-invalid={problems.threshold ? true : undefined}
            aria-describedby={field("threshold-hint")}
            onChange={(event) =>
              setDraft({ ...draft, threshold: Number(event.target.value) })
            }
          />
        </div>
        <p
          id={field("threshold-hint")}
          className="text-xs text-muted-foreground"
        >
          The score from 0 to 1 an iteration needs to pass.
        </p>
        <FieldError className="text-xs">{problems.threshold}</FieldError>
      </div>
    </EvaluatorEditorLayout>
  );
}
