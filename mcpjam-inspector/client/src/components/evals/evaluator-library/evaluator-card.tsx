import { Button } from "@mcpjam/design-system/button";
import {
  Check,
  ListChecks,
  Plus,
  Regex,
  Scale,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { EvaluatorPresetIcon } from "./evaluator-preset-icon";
import type { BuiltFromPart, EvaluatorTone } from "./evaluator-library-types";

const PART_ICON: Record<BuiltFromPart["kind"], LucideIcon> = {
  assertions: ListChecks,
  question: Sparkles,
  judge: Scale,
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
  /** A short line under the question, such as a judge's cost. */
  note?: string;
  inSuite?: boolean;
  onOpen: () => void;
  onAdd: () => void;
  addDisabledReason?: string;
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
  icon,
  tone,
  builtFrom,
  note,
  inSuite = false,
  onOpen,
  onAdd,
  addDisabledReason,
}: EvaluatorCardProps) {
  return (
    <article className="group relative flex flex-col gap-2.5 rounded-lg border border-border bg-popover p-3.5 transition-[border-color,box-shadow] hover:border-foreground/25 focus-within:border-ring">
      <div className="flex items-start gap-2.5">
        <EvaluatorPresetIcon icon={icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-card-foreground">
            <button
              type="button"
              onClick={onOpen}
              className="text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
            >
              {name}
            </button>
          </h4>
          <p className="text-sm text-muted-foreground">{question}</p>
          {note ? (
            <p className="text-xs text-muted-foreground">{note}</p>
          ) : null}
        </div>
        {inSuite ? (
          <span className="relative inline-flex shrink-0 items-center gap-1 rounded-sm bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
            <Check aria-hidden className="size-3" />
            In suite
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAdd}
            disabled={Boolean(addDisabledReason)}
            aria-label={`Add ${name} to suite`}
            // Keep a disabled Add above the stretched details button.
            className="relative z-10 h-7 shrink-0 disabled:pointer-events-auto"
          >
            <Plus aria-hidden />
            Add
          </Button>
        )}
      </div>
      {addDisabledReason && !inSuite ? (
        <p className="text-xs text-muted-foreground">{addDisabledReason}</p>
      ) : null}
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
      </div>
    </article>
  );
}
