import { Check } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";

/** One step in the checklist's left-hand list; selecting it shows its panel. */
export function ChecklistStepRow({
  index,
  title,
  surface,
  summary,
  done,
  selected,
  onSelect,
}: {
  index: number;
  title: string;
  surface: string;
  summary?: string | null;
  done: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "step" : undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-3.5 text-left transition-colors hover:bg-accent/60",
          selected && "bg-accent hover:bg-accent",
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-300",
            done
              ? "border-success text-success"
              : selected
                ? "border-primary text-primary"
                : "border-border text-muted-foreground",
          )}
          aria-hidden
        >
          {done ? <Check className="size-3.5" /> : index}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm font-medium",
              done ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
            {done ? <span className="sr-only"> (done)</span> : null}
          </span>
          <span className="block text-xs text-muted-foreground">{surface}</span>
        </span>
        {summary ? (
          <span className="max-w-[40%] shrink-0 text-right text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </button>
    </li>
  );
}
