import { Button } from "@mcpjam/design-system/button";
import { ArrowRight, type LucideIcon } from "lucide-react";

export type NotInLibraryCardProps = {
  icon: LucideIcon;
  title: string;
  /** One line on what lives there and why it is not an evaluator. */
  description: string;
  items: readonly string[];
  actionLabel: string;
  onAction: () => void;
};

/**
 * Closes the library grid. Some checks do not grade a single run (server
 * checks, run settings, case expectations); pointing at where they live stops
 * people looking for them as evaluators.
 */
export function NotInLibraryCard({
  icon: Icon,
  title,
  description,
  items,
  actionLabel,
  onAction,
}: NotInLibraryCardProps) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-popover p-3.5"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-card-foreground">
            {title}
          </h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="mt-auto">
        <Button type="button" size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </section>
  );
}
