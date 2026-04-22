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
  const item = (next: PlaygroundWorkspaceBrowse, label: string) => (
    <button
      key={next}
      type="button"
      role="tab"
      aria-selected={value === next}
      onClick={() => onChange(next)}
      className={cn(
        "border-b-2 pb-2 text-sm font-medium transition-colors -mb-px",
        value === next
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      role="tablist"
      className={cn(
        "flex w-full shrink-0 items-center justify-center gap-8 border-b bg-background px-6 pt-4",
        className,
      )}
    >
      {item("suites", "Suites")}
      {item("executions", "Executions")}
    </div>
  );
}
