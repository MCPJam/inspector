import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  hasCodeEvaluatorsCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import { CodeEvaluatorPreview } from "./code-evaluator-preview";
import {
  CODE_EVALUATOR_STARTERS,
  MAX_CODE_EVALUATOR_SOURCE_CHARS,
  MAX_CODE_EVALUATORS,
  codeEvaluatorIdFor,
  codeEvaluatorProblem,
  type CodeEvaluator,
} from "./code-evaluators-model";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";

const BLANK_SOURCE = `type Run = {
  finalAssistantMessage?: string;
  toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
};

export function evaluate(run: Run) {
  return { pass: true, reason: "Describe what you checked." };
}
`;

/**
 * Code evaluators in suite settings: TypeScript that grades every trial in a
 * sandbox. Required ones can fail a run, since the same code on the same
 * trial gives the same answer.
 */
export function CodeEvaluatorsSection({
  value,
  onChange,
  capabilities,
}: {
  value: CodeEvaluator[];
  onChange?: (next: CodeEvaluator[]) => void;
  capabilities: SuiteCapabilities | null | undefined;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  const [editing, setEditing] = useState<CodeEvaluator | null>(null);
  const [isNew, setIsNew] = useState(false);
  if (!enabled || !onChange || !hasCodeEvaluatorsCapability(capabilities)) {
    return null;
  }
  const taken = value.map((e) => e.id);
  const start = (draft: CodeEvaluator) => {
    setIsNew(true);
    setEditing(draft);
  };
  const save = (next: CodeEvaluator) => {
    onChange(isNew ? [...value, next] : value.map((e) => (e.id === next.id ? next : e)));
    setEditing(null);
  };
  const atMax = value.length >= MAX_CODE_EVALUATORS;
  return (
    <section aria-label="Code evaluators" className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">Code evaluators</h4>
          <p className="text-xs text-muted-foreground">
            TypeScript that grades every trial in a sandbox with no network,
            within 10 seconds. A crash or timeout reads as an error, never a fail.
          </p>
        </div>
        {editing ? null : (
          <div className="flex flex-wrap gap-2">
            {CODE_EVALUATOR_STARTERS.map((s) => (
              <Button
                key={s.id}
                type="button"
                size="sm"
                variant="ghost"
                disabled={atMax}
                onClick={() =>
                  start({
                    id: codeEvaluatorIdFor(s.label, taken),
                    label: s.label,
                    source: s.source,
                    role: s.role,
                    basedOn: { id: s.id, version: s.version },
                  })
                }
              >
                Start from: {s.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={atMax}
              title={atMax ? `A suite can have ${MAX_CODE_EVALUATORS} code evaluators.` : undefined}
              onClick={() =>
                start({
                  id: codeEvaluatorIdFor("code", taken),
                  label: "",
                  source: BLANK_SOURCE,
                  role: "advisory",
                })
              }
            >
              <Plus aria-hidden />
              Write code
            </Button>
          </div>
        )}
      </div>
      {value.length ? (
        <ul className="divide-y divide-border">
          {value.map((e) =>
            editing?.id === e.id && !isNew ? null : (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="text-foreground">{e.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {e.role === "required" ? "Required" : "Advisory"} ·{" "}
                    <span className="font-mono">{e.id}</span>
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${e.label}`}
                    onClick={() => {
                      setIsNew(false);
                      setEditing(e);
                    }}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${e.label}`}
                    onClick={() => onChange(value.filter((o) => o.id !== e.id))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {editing ? (
        <CodeEditor
          suiteId={capabilities?.suiteId}
          evaluator={editing}
          others={value.filter((e) => isNew || e.id !== editing.id)}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </section>
  );
}

function CodeEditor({
  suiteId,
  evaluator,
  others,
  onCancel,
  onSave,
}: {
  suiteId?: string;
  evaluator: CodeEvaluator;
  others: readonly CodeEvaluator[];
  onCancel: () => void;
  onSave: (next: CodeEvaluator) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(evaluator);
  const [tried, setTried] = useState(false);
  const problem = codeEvaluatorProblem(draft, others);
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-xs font-medium">
            Name
          </label>
          <Input
            id={`${id}-name`}
            value={draft.label}
            maxLength={200}
            placeholder="Invoice totals add up"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-id`} className="text-xs font-medium">
            Id
          </label>
          <Input
            id={`${id}-id`}
            value={draft.id}
            maxLength={64}
            className="font-mono"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-source`} className="text-xs font-medium">
          Code
        </label>
        <textarea
          id={`${id}-source`}
          rows={12}
          spellCheck={false}
          value={draft.source}
          maxLength={MAX_CODE_EVALUATOR_SOURCE_CHARS}
          className="w-full rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs text-foreground"
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Export <span className="font-mono">evaluate(run)</span> returning{" "}
          <span className="font-mono">{"{ pass, score?, reason }"}</span>.{" "}
          <span className="font-mono">run</span> holds the trial's tool calls,
          tool results and final answer. Avoid{" "}
          <span className="font-mono">enum</span> and{" "}
          <span className="font-mono">namespace</span>.
        </p>
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        <span className="font-medium">Role</span>
        <RadioGroup
          aria-label="Role"
          value={draft.role}
          onValueChange={(role) =>
            setDraft({ ...draft, role: role === "required" ? "required" : "advisory" })
          }
          className="flex flex-wrap gap-3"
        >
          <label htmlFor={`${id}-required`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-required`} value="required" />
            Required: a fail fails the trial
          </label>
          <label htmlFor={`${id}-advisory`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-advisory`} value="advisory" />
            Advisory
          </label>
        </RadioGroup>
      </div>
      {suiteId ? (
        <CodeEvaluatorPreview suiteId={suiteId} source={draft.source} disabledReason={problem} />
      ) : null}
      {tried && problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setTried(true);
            if (!problem) onSave({ ...draft, label: draft.label.trim() });
          }}
        >
          Save code
        </Button>
      </div>
    </div>
  );
}
