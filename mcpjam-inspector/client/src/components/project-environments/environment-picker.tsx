import { useMemo, useState, type ReactNode } from "react";
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
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { environmentLabel, isNamedEnvironment } from "@/lib/environment-label";

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
 *  - AD-HOC rows (machine-minted from a composition, no name) are fetched but
 *    never offered. A journey's `environmentIds` can point at one, and without
 *    the row in `environmentsById` the trigger would label it "…" — so the
 *    picker needs it present to LABEL, and excluded from `liveEnvironments` to
 *    never OFFER. Same split as the two cases above.
 *
 * None of the three is ever offered for new selection.
 *
 * `environmentLabel` is called WITHOUT a label context on purpose. The richer
 * "client name" label for an ad-hoc row would cost two project-wide queries,
 * and this component only ever labels an already-selected ad-hoc id — a rare
 * edge. Paying for that here would also break the pure-presentation contract
 * above, since it would make the picker fetch. The Environments page, which
 * lists ad-hoc rows for real, supplies the context.
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
  triggerTestId,
  triggerAriaLabel,
  inModal = false,
  footerSlot,
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
  /** Test hook + a11y label for the trigger, for callers that key on them. */
  triggerTestId?: string;
  triggerAriaLabel?: string;
  /**
   * Render the popover INLINE rather than in a portal, for callers that live
   * inside a Radix Dialog. A portalled popover lands outside the dialog, where
   * the modal overlay's `pointer-events: none` on the body swallows every
   * click. Same escape hatch, same name, as `ServerPicker`.
   */
  inModal?: boolean;
  /**
   * Optional actions above "Manage environments" in the popover footer
   * (e.g. promote an ad-hoc setup). Caller owns the content and click handlers.
   */
  footerSlot?: ReactNode;
}) {
  // Include archived AND ad-hoc so a still-attached row of either kind can be
  // labeled and detached (see the doc block above). Both are filtered out of
  // the offerable list below — fetching them is what makes the trigger able to
  // name what is already selected.
  const environments = useProjectEnvironments(projectId, {
    includeArchived: true,
    includeAdhoc: true,
  });
  const environmentsEnabled = useProjectEnvironmentsEnabled();

  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () =>
      multi
        ? ((value as string[] | null) ?? [])
        : value
          ? [value as string]
          : [],
    [multi, value],
  );

  const environmentsById = useMemo(
    () => new Map((environments ?? []).map((e) => [e.environmentId, e])),
    [environments],
  );
  const liveEnvironments = useMemo(
    () =>
      (environments ?? []).filter(
        (e) => !e.archivedAt && isNamedEnvironment(e),
      ),
    [environments],
  );
  const archivedSelected = useMemo(
    () =>
      selected
        .map((id) => environmentsById.get(id))
        .filter(
          (e): e is NonNullable<typeof e> => !!e && e.archivedAt !== undefined,
        ),
    [selected, environmentsById],
  );
  // Gated on the query having settled so a loading list doesn't flash every
  // selected id as an orphan.
  const orphanSelectedIds = useMemo(
    () =>
      environments === undefined
        ? []
        : selected.filter((id) => !environmentsById.has(id)),
    [environments, selected, environmentsById],
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
      : selected
          .map((id) => {
            const env = environmentsById.get(id);
            // "…" is for an id no row resolves at all (the orphan case). A row
            // that merely has no name — an ad-hoc one a journey points at —
            // labels by its client instead.
            return env ? environmentLabel(env) : "…";
          })
          .join(", ");

  return (
    <Popover open={open} onOpenChange={(next) => !inert && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={triggerTestId}
          aria-label={triggerAriaLabel}
          className={cn(
            "flex h-8 max-w-[280px] items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            selected.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-60",
            className,
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
      <PopoverContent
        className="w-72 p-1"
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
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
                      "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      toggle(env.environmentId, next === true)
                    }
                    disabled={capBlocked || inert}
                    aria-label={environmentLabel(env)}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {/* Offerable rows are named-only, so this IS the name —
                        routed through the helper so the type stays honest and
                        the vocabulary stays in one place. */}
                    {environmentLabel(env)}
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
                      "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  {/* Archived: uncheck to detach only — never re-attachable. */}
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(env.environmentId, false)}
                    disabled={inert}
                    aria-label={`${environmentLabel(env)} (archived)`}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {environmentLabel(env)}
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
                      "cursor-not-allowed opacity-60 hover:bg-transparent",
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
        {footerSlot || environmentsEnabled ? (
          <div className="mt-0.5 border-t pt-0.5">
            {footerSlot ? (
              // Close on the bubbled CLICK only. A keydown handler here would fire
              // before the browser dispatches a button's synthetic click for Enter
              // and Space, unmounting the footer action before it ever ran; the
              // click covers pointer and keyboard activation alike.
              <div className="contents" onClick={() => setOpen(false)}>
                {footerSlot}
              </div>
            ) : null}
            {/* With the flag off, /environments redirects to /servers. */}
            {environmentsEnabled ? (
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
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
