import { Plus, X } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import {
  SCENARIO_TASK_HINT_MAX,
  SCENARIO_TASK_LIMIT,
  SCENARIO_TASK_TITLE_MAX,
  emptyScenarioTaskDraft,
  type ScenarioTaskDraft,
} from "@/lib/scenario-tasks";
import { cn } from "@/lib/utils";

/**
 * The "what to try" list editor, shared by create step 2 and the study's
 * settings so the two cannot drift into different lists of the same thing.
 *
 * Uncontrolled of nothing: the parent owns the rows. Create holds them in
 * local state and writes once at the end; settings holds them beside a Save.
 * That split is the reason this component has no mutation of its own.
 *
 * A row is deliberately just a numbered text field. The number is POSITION,
 * not priority — the tester's list is a checklist they work in any order, and
 * anything that looked like a required sequence (a stepper, drag handles, a
 * progress bar) would turn a list into the exam this surface is not.
 */
interface ScenarioTaskListEditorProps {
  value: ScenarioTaskDraft[];
  onChange: (next: ScenarioTaskDraft[]) => void;
  disabled?: boolean;
  /** Namespaces the test ids so two editors can coexist in one test. */
  testIdPrefix: string;
  /** Placeholder for the first row, to seed the idea of a good task. */
  firstTitlePlaceholder?: string;
}

export function ScenarioTaskListEditor({
  value,
  onChange,
  disabled = false,
  testIdPrefix,
  firstTitlePlaceholder = "Find last month's unpaid invoices",
}: ScenarioTaskListEditorProps) {
  const atLimit = value.length >= SCENARIO_TASK_LIMIT;

  const patchRow = (id: string, patch: Partial<ScenarioTaskDraft>) => {
    onChange(value.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    onChange(value.filter((row) => row.id !== id));
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`${testIdPrefix}-tasks`}>
      {value.map((row, index) => (
        <div key={row.id} className="flex items-start gap-2.5">
          {/* Fixed 36px-tall box so the number sits on the input's centre
              line and stays there when the hint field opens below it. */}
          <div className="flex h-9 w-5.5 shrink-0 items-center justify-center">
            <span
              aria-hidden
              className="flex size-5.5 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
            >
              {index + 1}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Input
              value={row.title}
              disabled={disabled}
              maxLength={SCENARIO_TASK_TITLE_MAX}
              // The visible number is decorative, so the field needs its own
              // name for anyone not reading the layout.
              aria-label={`Task ${index + 1}`}
              placeholder={index === 0 ? firstTitlePlaceholder : "Another task"}
              data-testid={`${testIdPrefix}-task-title-${index}`}
              onChange={(e) => patchRow(row.id, { title: e.target.value })}
            />
            {/* The optional one-liner. Borderless and quiet until used: it is
                a detail on a task, and giving it a second boxed field would
                make every row look like two questions. Only offered once the
                task has a title — a detail with nothing to detail is noise. */}
            {row.title.trim().length > 0 ? (
              <input
                type="text"
                value={row.hint}
                disabled={disabled}
                maxLength={SCENARIO_TASK_HINT_MAX}
                aria-label={`Task ${index + 1} detail`}
                placeholder="Add a detail (optional)"
                data-testid={`${testIdPrefix}-task-hint-${index}`}
                onChange={(e) => patchRow(row.id, { hint: e.target.value })}
                className={cn(
                  "w-full border-0 bg-transparent px-3 py-0 text-xs text-muted-foreground outline-none",
                  "placeholder:text-muted-foreground/60 disabled:opacity-50",
                )}
              />
            ) : null}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeRow(row.id)}
            aria-label={`Remove task ${index + 1}`}
            data-testid={`${testIdPrefix}-task-remove-${index}`}
            className={cn(
              "flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              "hover:bg-accent hover:text-foreground focus-visible:outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            )}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}

      {/* Indented to the inputs' left edge, past the number column, so the
          list reads as one block rather than a list plus a stray button. */}
      {!atLimit ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...value, emptyScenarioTaskDraft()])}
          data-testid={`${testIdPrefix}-task-add`}
          className={cn(
            "ml-8 inline-flex w-fit items-center gap-1 rounded-sm text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-ring disabled:opacity-50",
          )}
        >
          <Plus className="size-3.5" />
          Add a task
        </button>
      ) : (
        <p
          className="ml-8 text-xs text-muted-foreground"
          data-testid={`${testIdPrefix}-task-limit`}
        >
          {SCENARIO_TASK_LIMIT} tasks is the most a study can ask for. Remove
          one to add another.
        </p>
      )}
    </div>
  );
}
