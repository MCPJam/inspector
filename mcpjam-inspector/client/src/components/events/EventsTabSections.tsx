import { cn } from "@mcpjam/design-system/cn";
export function EventsHeader({
  title = "Events",
  monospaceTitle,
  description,
  action,
}: {
  title?: string;
  monospaceTitle?: boolean;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <h2
          className={cn(
            "break-all text-sm font-semibold",
            monospaceTitle && "font-mono",
          )}
        >
          {title}
        </h2>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
    </header>
  );
}
