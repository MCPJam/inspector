import { Cloud } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small provenance chip for surfaces whose COMPUTER EXECUTION is cloud-only:
 * swarms, evals, and user-testing sessions run their bash/sandbox commands in
 * MCPJam cloud sandboxes regardless of where the inspector itself runs.
 *
 * Deliberately scoped to computer execution — it must not read as "this whole
 * run happens remotely" (a locally-launched swarm still orchestrates and calls
 * models from this process). The tooltip carries the per-surface nuance.
 *
 * Styled after the composer's "Custom" badge so provenance chips read as one
 * family.
 */
export function CloudRunBadge({
  tooltip,
  className,
  "data-testid": testId,
}: {
  tooltip?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
      title={tooltip}
      data-testid={testId ?? "cloud-run-badge"}
    >
      <Cloud className="size-3" aria-hidden />
      Computer: MCPJam cloud
    </span>
  );
}
