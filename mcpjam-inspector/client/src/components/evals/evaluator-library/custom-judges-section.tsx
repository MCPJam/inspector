import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import type { CustomJudge } from "@/components/shared/session-quality/judge-config";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  hasCustomJudgesCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import { judgeMode } from "../suite-grading-model";
import type { EvalJudgeConfig } from "../types";
import {
  blankJudge,
  CUSTOM_JUDGE_COST_COPY,
  customJudgeLimits,
  judgePromptVariables,
  judgeProblem,
  withJudges,
} from "./custom-judges-model";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";
import { CustomJudgePreview } from "./custom-judge-preview";
import { PromptEditor } from "./prompt-editor";
import { VariableMappingTable } from "./variable-mapping-table";

export function CustomJudgesSection({
  judgeConfig,
  onJudgeConfigChange,
  capabilities,
}: {
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange?: (next: EvalJudgeConfig | undefined) => void;
  capabilities: Pick<SuiteCapabilities, "suiteId" | "judges"> | null | undefined;
}) {
  const enabled = useEvaluatorLibraryEnabled();
  const all = judgeConfig?.customJudges?.judges ?? [];
  const written = all.filter((j) => !j.evaluator);
  const [editing, setEditing] = useState<CustomJudge | null>(null);
  const [isNew, setIsNew] = useState(false);
  // Custom judges ride the goal-completion judge, so its Off pauses them.
  const goalJudgeOff =
    judgeMode(judgeConfig, capabilities?.judges?.goalCompletion?.policy) === "off";
  const change = (next: EvalJudgeConfig) => onJudgeConfigChange?.(next);
  const save = (judge: CustomJudge) => {
    const next = isNew
      ? [...all, judge]
      : all.map((j) => (j.id === judge.id ? judge : j));
    change(withJudges(judgeConfig, next));
    setEditing(null);
  };
  const remove = (id: string) =>
    change(
      withJudges(
        judgeConfig,
        all.filter((j) => j.id !== id),
      ),
    );
  const { maxJudges, maxPromptLength } = customJudgeLimits(capabilities);
  const atMax = all.length >= maxJudges;
  if (!enabled || !onJudgeConfigChange) return null;
  if (!hasCustomJudgesCapability(capabilities)) return null;
  const variables = capabilities?.judges?.custom?.variables ?? [];
  return (
    <section
      aria-label="Judges you write"
      className="rounded-lg border border-border p-3"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            Judges you write
          </h4>
          <p className="text-xs text-muted-foreground">
            {CUSTOM_JUDGE_COST_COPY} Results are advisory.
            {goalJudgeOff ? " Paused while the goal-completion judge is off." : ""}
          </p>
        </div>
        {editing ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={atMax}
            title={atMax ? `A suite can have ${maxJudges} judges.` : undefined}
            onClick={() => {
              setIsNew(true);
              setEditing(blankJudge(all.map((j) => j.id)));
            }}
          >
            <Plus aria-hidden />
            Write a judge
          </Button>
        )}
      </div>
      {written.length ? (
        <ul className="divide-y divide-border">
          {written.map((judge) =>
            editing?.id === judge.id && !isNew ? null : (
              <JudgeRow
                key={judge.id}
                judge={judge}
                onEdit={() => {
                  setIsNew(false);
                  setEditing(judge);
                }}
                onRemove={() => remove(judge.id)}
              />
            ),
          )}
        </ul>
      ) : null}
      {editing ? (
        <JudgeEditor
          key={editing.id}
          suiteId={capabilities?.suiteId}
          judge={editing}
          variables={variables}
          maxPromptLength={maxPromptLength}
          isNew={isNew}
          others={all.filter((j) => isNew || j.id !== editing.id)}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </section>
  );
}

function outputSummary(judge: CustomJudge): string {
  return judge.output.kind === "score"
    ? `Score, passes at ${judge.output.threshold} or more`
    : "Pass or fail";
}

function JudgeRow({
  judge,
  onEdit,
  onRemove,
}: {
  judge: CustomJudge;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const parent = judge.basedOn ? findLibraryEvaluator(judge.basedOn.id) : null;
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <span>
        <span className="text-foreground">{judge.label}</span>
        <span className="block text-xs text-muted-foreground">
          {outputSummary(judge)}
          {judge.basedOn
            ? ` · Based on ${parent?.name ?? judge.basedOn.id} v${judge.basedOn.version}`
            : ""}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Edit ${judge.label}`}
          onClick={onEdit}
        >
          <Pencil aria-hidden />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove ${judge.label}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </span>
    </li>
  );
}

function JudgeEditor({
  suiteId,
  judge,
  variables,
  maxPromptLength,
  isNew,
  others,
  onCancel,
  onSave,
}: {
  suiteId?: string;
  judge: CustomJudge;
  variables: readonly string[];
  /** The backend's `judges.custom.maxPromptLength`. */
  maxPromptLength: number;
  isNew: boolean;
  others: readonly CustomJudge[];
  onCancel: () => void;
  onSave: (judge: CustomJudge) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(judge);
  const [tried, setTried] = useState(false);
  const problem = judgeProblem(draft, others, variables, maxPromptLength);
  const variableMappings = judgePromptVariables(variables);
  const threshold = draft.output.kind === "score" ? draft.output.threshold : 0.7;
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-xs font-medium">
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={draft.label}
          maxLength={200}
          placeholder="Cites the order number"
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </div>
      <PromptEditor
        value={draft.prompt}
        onChange={(prompt) => setDraft({ ...draft, prompt })}
        variables={variableMappings}
        maxLength={maxPromptLength}
      />
      <details className="text-xs">
        <summary className="mb-2 cursor-pointer text-muted-foreground">
          Variable reference
        </summary>
        <VariableMappingTable variables={variableMappings} />
      </details>
      <div className="flex flex-col gap-1.5 text-xs">
        <span className="font-medium">Result</span>
        <RadioGroup
          aria-label="Result"
          value={draft.output.kind}
          onValueChange={(kind) =>
            setDraft({
              ...draft,
              output:
                kind === "score" ? { kind: "score", threshold } : { kind: "passfail" },
            })
          }
          className="flex flex-wrap items-center gap-3"
        >
          <label htmlFor={`${id}-passfail`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-passfail`} value="passfail" />
            Pass or fail
          </label>
          <label htmlFor={`${id}-score`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-score`} value="score" />
            Score from 0 to 1, passing at
          </label>
          <Input
            type="number"
            aria-label="Passing score"
            className="h-7 w-20"
            min={0.05}
            max={1}
            step={0.05}
            disabled={draft.output.kind !== "score"}
            value={threshold}
            onChange={(e) =>
              setDraft({
                ...draft,
                output: { kind: "score", threshold: Number(e.target.value) },
              })
            }
          />
        </RadioGroup>
      </div>
      {suiteId ? (
        <CustomJudgePreview
          suiteId={suiteId}
          judge={draft}
          disabledReason={problem}
        />
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
          {isNew ? "Add judge" : "Save judge"}
        </Button>
      </div>
    </div>
  );
}
