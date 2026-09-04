/**
 * One chip naming the CONTEXT a run executed against (Project Environments,
 * Phase 3). An environment-backed run shows the environment name plus its
 * exact pinned revision; a legacy/host-backed run keeps today's `HostChip`
 * unchanged.
 *
 * Flag-gated identically to the run-detail "Environment" row: the rollback
 * kill-switch hides environment names/revisions on retained historical runs
 * too. With the flag off this chip is HOST-ONLY — an environment run (which
 * carries no `namedHostId`) falls through to the caller's neutral
 * `fallbackName`, never to the environment name wearing a host chip.
 */
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { cn } from "@/lib/utils";
import { HostChip } from "@/components/hosts/host-chip";
import { compactModelIdTail } from "@/lib/environment-label";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  runEnvironmentRef,
  runHostLabel,
  runRevisionLabel,
  type RunContextSource,
} from "./helpers";

type RunAttributionSource = RunContextSource & {
  effectiveModelId?: string;
  modelSource?: "client_default" | "override";
};

/**
 * The environment chip's presentation, shared by {@link RunContextChip} and the
 * case-run history batch header so the two cannot drift. Renders environment
 * identity unconditionally — every caller must have already checked the
 * `project-environments-enabled` flag.
 */
export function EnvironmentChip({
  name,
  environmentId,
  revisionLabel,
  className,
  nameClassName,
}: {
  name: string;
  environmentId: string;
  /** The exact revision this run pinned, e.g. `"rev 4"`. */
  revisionLabel?: string | null;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs",
        className
      )}
      title={`${name} · ${environmentId}`}
    >
      <span className={cn("truncate text-foreground", nameClassName)}>
        {name}
      </span>
      {revisionLabel ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {revisionLabel}
        </span>
      ) : null}
    </span>
  );
}

export function RunContextChip({
  run,
  hostNamesById,
  fallbackName,
  className,
  modelLabel,
}: {
  run: RunAttributionSource;
  /** namedHostId → display name, for legacy host-backed runs. */
  hostNamesById?: Map<string, string | null>;
  /** Shown when the run names neither an environment nor a host. */
  fallbackName?: string | null;
  className?: string;
  /** Catalog display name for `effectiveModelId`. Falls back to the id tail. */
  modelLabel?: string | null;
}) {
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const environmentRef = projectEnvironmentsEnabled
    ? runEnvironmentRef(run)
    : null;
  const modelId = run.effectiveModelId;
  const modelSource = run.modelSource;
  const resolvedModelLabel = modelId
    ? (modelLabel && compactModelLabel(modelLabel)) ||
      compactModelIdTail(modelId)
    : null;

  if (environmentRef) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
        <EnvironmentChip
          name={environmentRef.name}
          environmentId={environmentRef.environmentId}
          revisionLabel={runRevisionLabel(run)}
        />
        {resolvedModelLabel ? (
          <span
            className={cn(
              "truncate text-[11px]",
              modelSource === "override"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
            title={
              modelSource === "client_default"
                ? `Client default · ${resolvedModelLabel}`
                : modelSource === "override"
                  ? `Override · ${resolvedModelLabel}`
                  : resolvedModelLabel
            }
          >
            {resolvedModelLabel}
          </span>
        ) : null}
      </span>
    );
  }

  // The legacy/host branch — and where the kill-switch lands. Deliberately
  // `runHostLabel` and NOT `runContextLabel`: the latter re-derives the
  // environment name internally, which would put environment identity back on
  // screen (mislabelled as a host) with the flag off.
  const name = runHostLabel(run, hostNamesById) ?? fallbackName;
  if (!name) return null;
  // Same model attribution as the environment branch: a host chip by itself
  // only names the client, not which model actually ran.
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <HostChip name={name} hostId={run.namedHostId} className={className} />
      {resolvedModelLabel ? (
        <span
          className={cn(
            "truncate text-[11px]",
            modelSource === "override"
              ? "text-foreground"
              : "text-muted-foreground",
          )}
          title={
            modelSource === "client_default"
              ? `Client default · ${resolvedModelLabel}`
              : modelSource === "override"
                ? `Override · ${resolvedModelLabel}`
                : resolvedModelLabel
          }
        >
          {resolvedModelLabel}
        </span>
      ) : null}
    </span>
  );
}
