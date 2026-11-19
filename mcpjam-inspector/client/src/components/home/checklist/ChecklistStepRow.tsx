import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";

export function ChecklistStepRow({
  index,
  title,
  summary,
  done,
  open,
  onToggle,
  children,
}: {
  index: number;
  title: string;
  summary?: string | null;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = `home-checklist-step-${index}`;
  return (
    <li className="rounded-xl border border-border bg-card text-card-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left"
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-300",
            done
              ? "border-transparent bg-success/15 text-success"
              : "border-border text-muted-foreground",
          )}
          aria-hidden
        >
          {done ? <Check className="size-3.5" /> : index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {title}
            {done ? <span className="sr-only"> (done)</span> : null}
          </span>
          {summary ? (
            <span className="block truncate text-xs text-muted-foreground">
              {summary}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={bodyId}
          className="space-y-3 border-t border-border/60 px-4 py-4 sm:pl-13"
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}
