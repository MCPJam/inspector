/**
 * One chip naming the CONTEXT a run executed against (Project Environments,
 * Phase 3). An environment-backed run shows the environment name plus its
 * exact pinned revision; a legacy/host-backed run keeps today's `HostChip`
 * unchanged.
 *
 * Flag-gated identically to the run-detail "Environment" row: the rollback
 * kill-switch hides environment names/revisions on retained historical runs
 * too, falling back to the host rendering.
 */
import { cn } from "@/lib/utils";
import { HostChip } from "@/components/hosts/host-chip";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  runEnvironmentRef,
  runContextLabel,
  runRevisionLabel,
  type RunContextSource,
} from "./helpers";

export function RunContextChip({
  run,
  hostNamesById,
  fallbackName,
  className,
}: {
  run: RunContextSource;
  /** namedHostId → display name, for legacy host-backed runs. */
  hostNamesById?: Map<string, string | null>;
  /** Shown when the run names neither an environment nor a host. */
  fallbackName?: string | null;
  className?: string;
}) {
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const environmentRef = projectEnvironmentsEnabled
    ? runEnvironmentRef(run)
    : null;

  if (environmentRef) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs",
          className
        )}
        title={`${environmentRef.name} · ${environmentRef.environmentId}`}
      >
        <span className="truncate text-foreground">{environmentRef.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {runRevisionLabel(run)}
        </span>
      </span>
    );
  }

  const name = runContextLabel(run, hostNamesById) ?? fallbackName;
  if (!name) return null;
  return (
    <HostChip name={name} hostId={run.namedHostId} className={className} />
  );
}
