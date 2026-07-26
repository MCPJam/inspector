import { useMemo, useState } from "react";
import { ChevronDown, ExternalLink, Layers, Loader2 } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";

/** Backend cap on `suite.environmentIds` (and the journey fan-out list). */
export const MAX_SUITE_ENVIRONMENTS = 10;

/**
 * Controlled project-environment selector, shared by every surface that picks
 * environments (eval suites, journeys, and — from Phase 2 — the Playground).
 *
 * PURE PRESENTATION: it owns no persistence. Callers hold the value and decide
 * what committing means (a Convex mutation for suites, local preview state for
 * the Playground), which is what lets one component serve a
 * commit-on-every-toggle surface and an ephemeral one.
 *
 * Two behaviors that look like edge cases but are load-bearing:
 *
 *  - ARCHIVED rows that are still selected render as detach-only. A live-only
 *    list would simply drop them, stranding the id with a "…" label and no way
 *    to remove it.
 *  - ORPHAN ids (selected but returned by no row at all — hard-deleted, or
 *    moved out of the project) render the same way, for the same reason.
 *    `archivedSelected` cannot surface these, because it resolves ids THROUGH
 *    the row map, so a missing id filters away silently.
 *
 * Neither is ever offered for new selection.
 */
export function EnvironmentPicker({
  projectId,
  value,
  onChange,
  multi = true,
  max = MAX_SUITE_ENVIRONMENTS,
  disabled = false,
  busy = false,
  emptyLabel = "No environments · pick some",
  className,
}: {
  projectId: string;
  /** Selected id(s). Single-select accepts `string | null`. */
  value: string | string[] | null;
  /** Receives the same shape as `value` (array when `multi`). */
  onChange: (next: any) => void;
  multi?: boolean;
  /** Ignored when `multi` is false. */
  max?: number;
  disabled?: boolean;
  /** Shows the spinner while the caller persists. */
  busy?: boolean;
  emptyLabel?: string;
  className?: string;
}) {
  // Include archived so a still-attached archived row can surface and be
  // detached (see the doc block above).
  const environments = useProjectEnvironments(projectId, {
    includeArchived: true,
  });

  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () =>
      multi ? (value as string[] | null) ?? [] : value ? [value as string] : [],
    [multi, value]
  );

  const environmentsById = useMemo(
    () => new Map((environments ?? []).map((e) => [e.environmentId, e])),
    [environments]
  );
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
  // Gated on the query having settled so a loading list doesn't flash every
  // selected id as an orphan.
  const orphanSelectedIds = useMemo(
    () =>
      environments === undefined
        ? []
        : selected.filter((id) => !environmentsById.has(id)),
    [environments, selected, environmentsById]
  );

  const emit = (next: string[]) => {
    if (multi) {
      onChange(next);
    } else {
      onChange(next[0] ?? null);
      setOpen(false);
    }
  };

  const toggle = (environmentId: string, checked: boolean) => {
    if (!multi) {
      emit(checked ? [environmentId] : []);
      return;
    }
    if (checked) {
      if (selected.length >= max) return;
      emit([...selected, environmentId]);
    } else {
      emit(selected.filter((id) => id !== environmentId));
    }
  };

  const inert = disabled || busy;
  const triggerLabel =
    selected.length === 0
      ? emptyLabel
      : selected.map((id) => environmentsById.get(id)?.name ?? "…").join(", ");

  return (
    <Popover open={open} onOpenChange={(next) => !inert && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-8 max-w-[280px] items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selected.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60",
            className
          )}
        >
          <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {multi && selected.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              · {selected.length}
            </span>
          ) : null}
          {busy ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start" sideOffset={4}>
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {multi ? "Environments · run order" : "Environments"}
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
              const capBlocked = multi && !checked && selected.length >= max;
              return (
                <Label
                  key={env.environmentId}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    (capBlocked || inert) &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(env.environmentId, next === true)
                    }
                    disabled={capBlocked || inert}
                    aria-label={env.name}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {env.name}
                  </span>
                  {multi && checked ? (
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
                    inert &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  {/* Archived: uncheck to detach only — never re-attachable. */}
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(env.environmentId, false)}
                    disabled={inert}
                    aria-label={`${env.name} (archived)`}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {env.name}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (archived)
                    </span>
                  </span>
                  {multi ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                      {ordinal + 1}
                    </span>
                  ) : null}
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
                    inert &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  {/* Unresolvable: uncheck to detach only. There is no name to
                      show — the row exists purely so the id is removable. */}
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(environmentId, false)}
                    disabled={inert}
                    aria-label={`Unavailable environment ${environmentId} (detach)`}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                    Unavailable environment
                    <span className="ml-1 font-mono text-[10px]">
                      {environmentId.slice(0, 8)}
                    </span>
                  </span>
                  {multi ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                      {ordinal + 1}
                    </span>
                  ) : null}
                </Label>
              );
            })}
          </div>
        )}
        {multi && selected.length >= max ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            Cap reached — at most {max} environments.
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
