import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import type { CustomJudge } from "@/components/shared/session-quality/judge-config";
import { Pencil, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  hasCustomJudgesCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "../types";
import {
  CUSTOM_JUDGE_COST_COPY,
  customJudgeLimits,
  judgePromptVariables,
  judgeProblem,
  withFreeId,
  withJudges,
} from "./custom-judges-model";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";
import { libraryPauseMessages } from "./library-pause";
import { CustomJudgePreview } from "./custom-judge-preview";
import { draftChanged, EvaluatorEditorLayout } from "./evaluator-editor-layout";
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
  const pauseMessage = libraryPauseMessages(judgeConfig, capabilities).judges;
  const change = (next: EvalJudgeConfig) => onJudgeConfigChange?.(next);
  const save = (judge: CustomJudge) => {
    const next = all.map((j) => (j.id === judge.id ? judge : j));
    change(withJudges(judgeConfig, next));
    setEditing(null);
    return undefined;
  };
  const remove = (id: string) =>
    change(
      withJudges(
        judgeConfig,
        all.filter((j) => j.id !== id),
      ),
    );
  const { maxPromptLength } = customJudgeLimits(capabilities);
  // Nothing else in the app writes this switch, so turning judges back on
  // lives here.
  const off = judgeConfig?.customJudges?.enabled === false;
  // New judges come from the library's Judge prompt card; this section edits
  // the ones the suite already wrote.
  const shown = enabled && onJudgeConfigChange && (written.length || off);
  if (!shown) return null;
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
            {pauseMessage ? ` ${pauseMessage}` : ""}
          </p>
        </div>
        {off ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              change({
                ...judgeConfig,
                customJudges: { enabled: true, judges: all },
              })
            }
          >
            Turn on custom judges
          </Button>
        ) : null}
      </div>
      {written.length ? (
        <ul className="divide-y divide-border">
          {written.map((judge) =>
            editing?.id === judge.id ? null : (
              <JudgeRow
                key={judge.id}
                judge={judge}
                onEdit={() => setEditing(judge)}
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
          isNew={false}
          others={all.filter((j) => j.id !== editing.id)}
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

/**
 * Writes or edits one judge, inline in suite settings or in the library
 * dialog. `pauseMessage` says when the suite will not run it.
 */
export function JudgeEditor({
  inDialog = false,
  pauseMessage,
  suiteId,
  judge,
  variables,
  maxPromptLength,
  isNew,
  others,
  onCancel,
  onSave,
  onDirtyChange,
}: {
  inDialog?: boolean;
  pauseMessage?: string;
  suiteId?: string;
  judge: CustomJudge;
  variables: readonly string[];
  /** The backend's `judges.custom.maxPromptLength`. */
  maxPromptLength: number;
  isNew: boolean;
  others: readonly CustomJudge[];
  onCancel: () => void;
  /** Saves the judge, or says why the suite refused it. */
  onSave: (judge: CustomJudge) => string | undefined;
  /** The dialog asks before closing over a changed draft. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const [draft, setDraftState] = useState(judge);
  const setDraft = (next: CustomJudge) => {
    setDraftState(next);
    onDirtyChange?.(draftChanged(next, judge));
  };
  const [tried, setTried] = useState(false);
  // Why the suite refused the save, when the draft itself was fine.
  const [refusal, setRefusal] = useState<string>();
  // A judge added while this new one was open cannot clash with its ID.
  const taken = others.map((o) => o.id);
  const candidate = isNew ? withFreeId(draft, taken) : draft;
  const problem = judgeProblem(candidate, others, variables, maxPromptLength);
  const variableMappings = judgePromptVariables(variables);
  const threshold = draft.output.kind === "score" ? draft.output.threshold : 0.7;
  return (
    <EvaluatorEditorLayout
      inDialog={inDialog}
      inlineClassName="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3"
      action={isNew ? "Add judge" : "Save judge"}
      error={tried ? (problem ?? refusal) : undefined}
      onCancel={onCancel}
      onSubmit={() => {
        setTried(true);
        if (!problem)
          setRefusal(onSave({ ...candidate, label: candidate.label.trim() }));
      }}
    >
      {inDialog ? (
        <p className="text-sm text-muted-foreground">
          {CUSTOM_JUDGE_COST_COPY}
        </p>
      ) : null}
      {pauseMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {pauseMessage}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
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
      <details className="text-sm text-muted-foreground">
        <summary className="w-fit cursor-pointer">Variable reference</summary>
        <div className="mt-2">
          <VariableMappingTable variables={variableMappings} />
        </div>
      </details>
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Result</p>
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
          className="flex flex-wrap items-center gap-x-4 gap-y-2"
        >
          <label htmlFor={`${id}-passfail`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-passfail`} value="passfail" />
            Pass or fail
          </label>
          <label htmlFor={`${id}-score`} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-score`} value="score" />
            Score from 0 to 1
          </label>
        </RadioGroup>
        {draft.output.kind === "score" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${id}-threshold`}>Passing score</Label>
            <Input
              id={`${id}-threshold`}
              type="number"
              className="w-24"
              min={0.05}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  output: { kind: "score", threshold: Number(e.target.value) },
                })
              }
            />
          </div>
        ) : null}
      </div>
      {suiteId ? (
        <CustomJudgePreview
          suiteId={suiteId}
          judge={draft}
          disabledReason={problem}
          inDialog={inDialog}
        />
      ) : null}
    </EvaluatorEditorLayout>
  );
}
