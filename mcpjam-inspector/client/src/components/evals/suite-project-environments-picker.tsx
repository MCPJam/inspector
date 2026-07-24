import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { ChevronDown, ExternalLink, Layers, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { convexErrMessage } from "@/lib/convex-error";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";

/** Backend cap on `suite.environmentIds`. */
export const MAX_SUITE_ENVIRONMENTS = 10;

/**
 * Ordered multi-select of project environments for a suite. Selection order
 * IS attach order (ordinal badges) — Run all fans out one run per
 * environment in this order. Commits through
 * `testSuites:setSuiteEnvironments`; backend rejections (dupes, cap,
 * schedule-pin conflicts) surface verbatim.
 */
export function SuiteProjectEnvironmentsPicker({
  suiteId,
  projectId,
  environmentIds,
}: {
  suiteId: string;
  projectId: string;
  /** The suite's persisted attach-ordered environment ids. */
  environmentIds: string[] | undefined;
}) {
  // Include archived so a suite whose attached environment was later archived
  // can still surface (and DETACH) that row — a live-only list would drop it,
  // leaving the id stuck with only a "…" label and no way to remove it.
  const environments = useProjectEnvironments(projectId, {
    includeArchived: true,
  });
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as any
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[] | null;
  }) => Promise<unknown>;

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = environmentIds ?? [];
  const environmentsById = useMemo(
    () => new Map((environments ?? []).map((e) => [e.environmentId, e])),
    [environments]
  );
  // Live envs are attachable; archived envs that are STILL attached to this
  // suite render as detach-only rows (never offered for new selection).
  const liveEnvironments = useMemo(
    () => (environments ?? []).filter((e) => !e.archivedAt),
    [environments]
  );
  const archivedSelected = useMemo(
    () =>
      selected
        .map((id) => environmentsById.get(id))
        .filter(
          (e): e is NonNullable<typeof e> => !!e && e.archivedAt !== undefined
        ),
    [selected, environmentsById]
  );
  // An attached id the query doesn't return AT ALL (hard-deleted, or no longer
  // in this project). `archivedSelected` cannot surface these — it resolves
  // through `environmentsById`, so a missing id filters away silently and the
  // suite stays stuck referencing something with no row and no way to detach
  // it. Render them as detach-only rows, same as archived. Gated on the query
  // having settled so a loading list doesn't flash every attached id as an
  // orphan.
  const orphanSelectedIds = useMemo(
    () =>
      environments === undefined
        ? []
        : selected.filter((id) => !environmentsById.has(id)),
    [environments, selected, environmentsById]
  );

  const commit = async (next: string[]) => {
    setSaving(true);
    try {
      await setSuiteEnvironments({
        suiteId,
        environmentIds: next.length > 0 ? next : null,
      });
    } catch (err) {
      // Includes the backend's schedule-pin conflict rejection — surface it
      // verbatim so the user sees which enabled schedule blocks the change.
      toast.error(convexErrMessage(err, "Failed to update environments"));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (environmentId: string, checked: boolean) => {
    if (checked) {
      if (selected.length >= MAX_SUITE_ENVIRONMENTS) return;
      void commit([...selected, environmentId]);
    } else {
      void commit(selected.filter((id) => id !== environmentId));
    }
  };

  const triggerLabel =
    selected.length === 0
      ? "No environments · pick some"
      : selected.map((id) => environmentsById.get(id)?.name ?? "…").join(", ");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 max-w-[280px] items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selected.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60"
          )}
        >
          <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {selected.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              · {selected.length}
            </span>
          ) : null}
          {saving ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start" sideOffset={4}>
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Environments · run order
        </div>
        {environments === undefined ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : liveEnvironments.length === 0 &&
          archivedSelected.length === 0 &&
          orphanSelectedIds.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No environments in this project yet.
          </p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {liveEnvironments.map((env) => {
              const ordinal = selected.indexOf(env.environmentId);
              const checked = ordinal !== -1;
              const capBlocked =
                !checked && selected.length >= MAX_SUITE_ENVIRONMENTS;
              return (
                <Label
                  key={env.environmentId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    (capBlocked || saving) &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(env.environmentId, next === true)
                    }
                    disabled={capBlocked || saving}
                    aria-label={env.name}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {env.name}
                  </span>
                  {checked ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                      {ordinal + 1}
                    </span>
                  ) : null}
                </Label>
              );
            })}
            {archivedSelected.map((env) => {
              const ordinal = selected.indexOf(env.environmentId);
              return (
                <Label
                  key={env.environmentId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    saving &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  {/* Archived: uncheck to detach only — never re-attachable. */}
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(env.environmentId, false)}
                    disabled={saving}
                    aria-label={`${env.name} (archived)`}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {env.name}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (archived)
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                    {ordinal + 1}
                  </span>
                </Label>
              );
            })}
            {orphanSelectedIds.map((environmentId) => {
              const ordinal = selected.indexOf(environmentId);
              return (
                <Label
                  key={environmentId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    saving &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  {/* Unresolvable: uncheck to detach only. There is no name to
                      show — the row exists purely so the id is removable. */}
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(environmentId, false)}
                    disabled={saving}
                    aria-label={`Unavailable environment ${environmentId} (detach)`}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                    Unavailable environment
                    <span className="ml-1 font-mono text-[10px]">
                      {environmentId.slice(0, 8)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                    {ordinal + 1}
                  </span>
                </Label>
              );
            })}
          </div>
        )}
        {selected.length >= MAX_SUITE_ENVIRONMENTS ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            Cap reached — a suite can attach at most {MAX_SUITE_ENVIRONMENTS}{" "}
            environments.
          </p>
        ) : null}
        <div className="mt-0.5 border-t pt-0.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigateApp(routePaths.environments);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <ExternalLink className="size-3.5 shrink-0" />
            Manage environments →
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
