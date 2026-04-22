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
          "relative flex-1 rounded-md px-4 py-2 text-sm font-medium transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
          active
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
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
        "flex w-full shrink-0 items-stretch justify-center border-b border-border/60 bg-muted/30 px-4 pb-3 pt-4",
        className,
      )}
    >
      <div className="flex w-full max-w-md items-center gap-0.5 rounded-lg border border-border/50 bg-muted/50 p-1 shadow-inner">
        {item("suites", "Suites")}
        {item("executions", "Executions")}
      </div>
    </div>
  );
}
