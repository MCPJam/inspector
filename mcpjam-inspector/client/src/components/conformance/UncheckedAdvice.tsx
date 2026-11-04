import { Info } from "lucide-react";

/**
 * Picked advice the run could not judge, and why. Grey, not amber: nothing
 * was found wrong, the run just saw nothing the advice applies to.
 */
export function UncheckedAdvice({
  unchecked,
}: {
  unchecked?: Array<{ id: string; title: string; reason: string }>;
}) {
  if (!unchecked || unchecked.length === 0) return null;
  return (
    <div className="my-2 space-y-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
      {unchecked.map((entry) => (
        <div key={entry.id} className="flex items-start gap-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{entry.title}</span>
            <span className="text-muted-foreground">{entry.reason}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
