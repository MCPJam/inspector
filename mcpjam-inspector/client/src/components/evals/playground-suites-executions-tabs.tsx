import { cn } from "@/lib/utils";

export type PlaygroundWorkspaceBrowse = "suites" | "executions";

export function PlaygroundSuitesExecutionsTabs({
  value,
  onChange,
  className,
}: {
  value: PlaygroundWorkspaceBrowse;
  onChange: (value: PlaygroundWorkspaceBrowse) => void;
  className?: string;
}) {
  const item = (next: PlaygroundWorkspaceBrowse, label: string) => {
    const active = value === next;
    return (
      <button
        key={next}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onChange(next)}
        className={cn(
          "relative -mb-px border-b-2 border-transparent px-1 pb-3 pt-1 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
          active
            ? "border-primary text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      role="tablist"
      className={cn(
        "flex w-full shrink-0 items-center gap-8 border-b border-border/60 px-5 pt-3",
        className,
      )}
    >
      {item("suites", "Suites")}
      {item("executions", "Executions")}
    </div>
  );
}
