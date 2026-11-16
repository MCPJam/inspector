import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Slider } from "@mcpjam/design-system/slider";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { Trash2 } from "lucide-react";
import { RoleSegmentGroup } from "../scorer-role-control";
import type { ScorerUiRole } from "../suite-scorer-table-model";
import { RunWhenSelect, type RunWhen } from "./run-when-select";

export type QuestionKind = "yesno" | "choice" | "score";

export type ModelQuestion = {
  label: string;
  kind: QuestionKind;
  /** Yes/no: which answer passes. */
  passOn: "yes" | "no";
  /** Choice: the pass mark lives on each option. */
  options: { label: string; passes: boolean }[];
  /** Score: the lowest passing score, 0 to 1. */
  threshold: number;
  runWhen: RunWhen;
  role: ScorerUiRole;
};

const KINDS: { value: QuestionKind; label: string }[] = [
  { value: "yesno", label: "Yes/no" },
  { value: "choice", label: "Choice" },
  { value: "score", label: "Score" },
];

function isKind(value: string): value is QuestionKind {
  return KINDS.some((kind) => kind.value === value);
}

/**
 * A typed question a small classifier answers. Pass marks sit on the answers
 * so nobody has to remember which one is good. Model questions default to
 * Advisory, so a classifier explains a failure without deciding it.
 */
export function ModelQuestionCard({
  value,
  onChange,
  estimatedCalls,
  onRemove,
}: {
  value: ModelQuestion;
  onChange: (next: ModelQuestion) => void;
  /** Per-match questions: model calls one run will make. */
  estimatedCalls?: number;
  onRemove?: () => void;
}) {
  const set = (patch: Partial<ModelQuestion>) =>
    onChange({ ...value, ...patch });
  return (
    <section
      aria-label={value.label || "New question"}
      className="flex flex-col gap-3 rounded-lg border border-border bg-popover p-3.5"
    >
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          aria-label="Question kind"
          value={value.kind}
          onValueChange={(next) => isKind(next) && set({ kind: next })}
        >
          {KINDS.map((kind) => (
            <ToggleGroupItem key={kind.value} value={kind.value}>
              {kind.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="ml-auto">
          <RoleSegmentGroup
            value={value.role}
            ariaLabel="Question role"
            onChange={(role) => set({ role })}
          />
        </span>
        {onRemove ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove question"
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Question
        <Input
          value={value.label}
          onChange={(event) => set({ label: event.target.value })}
        />
      </label>
      <PassControl value={value} set={set} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RunWhenSelect
          value={value.runWhen}
          onChange={(runWhen) => set({ runWhen })}
        />
        {value.runWhen === "per-match" && estimatedCalls !== undefined ? (
          <span>About {estimatedCalls} model calls per run</span>
        ) : null}
      </div>
    </section>
  );
}

function PassControl({
  value,
  set,
}: {
  value: ModelQuestion;
  set: (patch: Partial<ModelQuestion>) => void;
}) {
  if (value.kind === "yesno") {
    return (
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        aria-label="Passes when the answer is"
        value={value.passOn}
        onValueChange={(next) =>
          (next === "yes" || next === "no") && set({ passOn: next })
        }
      >
        <ToggleGroupItem value="yes">Passes on Yes</ToggleGroupItem>
        <ToggleGroupItem value="no">Passes on No</ToggleGroupItem>
      </ToggleGroup>
    );
  }
  if (value.kind === "choice") {
    return (
      <ul aria-label="Options" className="flex flex-col gap-1.5">
        {value.options.map((option, index) => (
          <li key={option.label} className="flex items-center gap-2 text-sm">
            <Checkbox
              aria-label={`${option.label} passes`}
              checked={option.passes}
              onCheckedChange={(checked) =>
                set({
                  options: value.options.map((o, i) =>
                    i === index ? { ...o, passes: checked === true } : o,
                  ),
                })
              }
            />
            {option.label}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-muted-foreground">Passes at</span>
      <Slider
        aria-label="Passing score"
        className="max-w-48"
        min={0}
        max={1}
        step={0.05}
        value={[value.threshold]}
        onValueChange={([threshold]) => set({ threshold })}
      />
      <span className="font-mono">{value.threshold.toFixed(2)}</span>
    </div>
  );
}
