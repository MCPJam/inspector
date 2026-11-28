import { Button } from "@mcpjam/design-system/button";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { codeEvaluatorSummary } from "./code-evaluator-model";
import { CodeEvaluatorEditor } from "./code-evaluator-editor";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import {
  codeEvaluatorRunRefusal,
  requiredRoleRefusal,
  type SuiteCodeEvaluators,
} from "./suite-code-evaluators";

/**
 * The suite's code evaluators in suite settings, edited and removed the way
 * "Judges you write" are. New ones come from the library's Code card.
 * Without the `eval-code-evaluators` flag they show read-only and can still
 * be removed, since clearing is never gated.
 */
export function CodeEvaluatorsSection({
  codeEvaluators,
}: {
  codeEvaluators: SuiteCodeEvaluators;
}) {
  const libraryEnabled = useEvaluatorLibraryEnabled();
  const [editingId, setEditingId] = useState<string | null>(null);
  const { evaluators, gate, onChange } = codeEvaluators;
  if (evaluators.length === 0) return null;
  const canEdit = gate.canEdit && libraryEnabled;
  const editing = canEdit
    ? evaluators.find((evaluator) => evaluator.id === editingId)
    : undefined;
  const notes = [
    !gate.canEdit && gate.reason
      ? `${gate.reason}. These code evaluators still run, and you can remove them.`
      : undefined,
    codeEvaluatorRunRefusal(codeEvaluators),
  ].filter((note): note is string => Boolean(note));
  return (
    <section
      aria-label="Code evaluators"
      className="rounded-lg border border-border p-3"
    >
      <div className="mb-2 space-y-1">
        <h4 className="text-sm font-medium text-foreground">Code evaluators</h4>
        <p className="text-xs text-muted-foreground">
          Scripts that grade each iteration in a grading box of their own.
        </p>
        {notes.map((note) => (
          <p key={note} role="status" className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
      <ul className="divide-y divide-border">
        {evaluators.map((evaluator) =>
          evaluator.id === editing?.id ? null : (
            <li
              key={evaluator.id}
              className="flex items-start justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="text-foreground">
                  {evaluator.name ?? evaluator.id}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {codeEvaluatorSummary(evaluator)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {canEdit ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${evaluator.name ?? evaluator.id}`}
                    onClick={() => setEditingId(evaluator.id)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${evaluator.name ?? evaluator.id}`}
                  onClick={() =>
                    onChange(evaluators.filter((item) => item !== evaluator))
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </span>
            </li>
          ),
        )}
      </ul>
      {editing ? (
        <CodeEvaluatorEditor
          key={editing.id}
          evaluator={editing}
          others={evaluators.filter((item) => item.id !== editing.id)}
          scripts={codeEvaluators.scripts}
          requiredRefusal={requiredRoleRefusal(codeEvaluators.gradingMode)}
          test={codeEvaluators.test}
          onCancel={() => setEditingId(null)}
          onSave={(next) => {
            onChange(
              evaluators.map((item) => (item.id === next.id ? next : item)),
            );
            setEditingId(null);
            return undefined;
          }}
        />
      ) : null}
    </section>
  );
}
