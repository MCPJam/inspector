import { Button } from "@mcpjam/design-system/button";
import {
  Check,
  Code2,
  ListChecks,
  Plus,
  Regex,
  Scale,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CaseFieldDependency } from "./case-field-dependency";
import { OwaspTag } from "./evaluator-kind-badge";
import type {
  BuiltFromPart,
  CaseField,
  EvaluatorTone,
  OwaspId,
} from "./evaluator-library-types";

const TONE_CLASS: Record<EvaluatorTone, string> = {
  tools: "bg-info/10 text-info",
  answer: "bg-success/10 text-success",
  errors: "bg-primary/10 text-primary",
  security: "bg-destructive/10 text-destructive",
};

const PART_ICON: Record<BuiltFromPart["kind"], LucideIcon> = {
  assertions: ListChecks,
  question: Sparkles,
  judge: Scale,
  code: Code2,
  pattern: Regex,
};

export type EvaluatorCardProps = {
  /** What is checked, 2 to 4 words: "Expected Tool Calls". */
  name: string;
  /** The question it answers about one run: "Did the agent…?" */
  question: string;
  icon: LucideIcon;
  tone: EvaluatorTone;
  builtFrom: readonly BuiltFromPart[];
  owasp?: readonly OwaspId[];
  /** The case field this evaluator compares the run against, if any. */
  dependency?: CaseField;
  inSuite?: boolean;
  selected?: boolean;
  onOpen: () => void;
  /** Omit to hide the Add action, e.g. when the suite is read-only. */
  onAdd?: () => void;
};

/**
 * One evaluator in the library grid.
 *
 * The whole card opens the evaluator: the name is a button whose hit area is
 * stretched over the card, so there is no clickable div and Add stays a
 * separate, reachable control instead of a button nested in a button.
 */
export function EvaluatorCard({
  name,
  question,
  icon: Icon,
  tone,
  builtFrom,
  owasp,
  dependency,
  inSuite = false,
  selected = false,
  onOpen,
  onAdd,
}: EvaluatorCardProps) {
  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group relative flex min-h-40 flex-col gap-2.5 rounded-lg border border-border bg-popover p-3.5 transition-[border-color,box-shadow]",
        "hover:border-foreground/25 focus-within:border-ring",
        selected && "border-primary ring-[3px] ring-primary/15",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-md",
            TONE_CLASS[tone],
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-card-foreground">
            <button
              type="button"
              onClick={onOpen}
              className="text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
            >
              {name}
            </button>
          </h3>
          <p className="text-sm text-muted-foreground">{question}</p>
        </div>
        {inSuite ? (
          <span className="relative inline-flex shrink-0 items-center gap-1 rounded-sm bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
            <Check aria-hidden className="size-3" />
            In suite
          </span>
        ) : onAdd ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAdd}
            aria-label={`Add ${name} to suite`}
            className="relative z-10 h-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
          >
            <Plus aria-hidden />
            Add
          </Button>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
        {builtFrom.map((part) => {
          const PartIcon = PART_ICON[part.kind];
          return (
            <span key={part.label} className="inline-flex items-center gap-1">
              <PartIcon aria-hidden className="size-3.5" />
              {part.label}
            </span>
          );
        })}
        {owasp ? <OwaspTag ids={owasp} /> : null}
        <span className="ml-auto">
          {dependency ? (
            <CaseFieldDependency field={dependency} />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-success" />
              Ready
            </span>
          )}
        </span>
      </div>
    </article>
  );
}
