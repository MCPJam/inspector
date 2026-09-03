import { type ReactNode, useMemo } from "react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { getConnectionStatusMeta } from "@/components/connection/server-card-utils";
import type { ConnectionStatus } from "@/state/app-types";
import { cn } from "@/lib/utils";

/**
 * Minimal server identity for selection UI. Keep this leaf decoupled from
 * concrete project-server / runtime-server shapes — callers project their
 * own type (RemoteServer, ServerWithName, etc.) down into ServerOption.
 *
 * `meta` is optional secondary text shown muted under the name (e.g. URL
 * or transport label). Skip it for compact rows.
 */
export type ServerOption = {
  id: string;
  name: string;
  meta?: string;
  /** Live connection status. Absent means unknown, which draws no mark. */
  status?: ConnectionStatus;
};

interface ServerSelectionListProps {
  /** Servers to render, in display order. */
  servers: ReadonlyArray<ServerOption>;
  /** Currently-selected server IDs. */
  selectedIds: ReadonlySet<string>;
  /** Called when the user toggles a row. `next` is the post-toggle state. */
  onToggle: (id: string, next: boolean) => void;
  /** Disable all checkboxes (read-only-ish display). */
  disabled?: boolean;
  /** Rendered in place of the list when `servers` is empty. */
  emptyState?: ReactNode;
  /** Optional ARIA label for the surrounding group; defaults to "Servers". */
  ariaLabel?: string;
}

/**
 * Pure controlled list of server checkboxes. No data fetching, no
 * business rules — callers own `selectedIds` and the toggle handler.
 *
 * Used by the suite/scenario attachment editor's Servers tab and any
 * future surface that needs the same per-server selection UX. Stay
 * structural — transport badges and per-row actions layer on top via a
 * richer wrapper, not here. Connection status is the exception, and is
 * drawn here because the row is where the choice is made: hiding it let a
 * failed server be picked as readily as a working one (BB-49).
 */
export function ServerSelectionList({
  servers,
  selectedIds,
  onToggle,
  disabled = false,
  emptyState,
  ariaLabel = "Servers",
}: ServerSelectionListProps) {
  const stableSelected = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (servers.length === 0) {
    return (
      <div role="group" aria-label={ariaLabel}>
        {emptyState ?? (
          <p className="px-2 py-1 text-xs italic text-muted-foreground">
            No servers available.
          </p>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-col gap-1">
      {servers.map((server) => {
        const checked = stableSelected.has(server.id);
        const statusMeta = server.status
          ? getConnectionStatusMeta(server.status)
          : null;
        return (
          <Label
            key={server.id}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
              disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
            )}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={(next) => onToggle(server.id, next === true)}
              disabled={disabled}
              // The status rides the accessible name so the mark is never
              // colour-only; the dot below is its sighted half.
              aria-label={
                statusMeta
                  ? `${server.name} (${statusMeta.label})`
                  : server.name
              }
            />
            {statusMeta ? (
              <span
                data-testid={`server-status-${server.id}`}
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  statusMeta.indicatorClassName,
                )}
                title={statusMeta.label}
                aria-hidden
              />
            ) : null}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-normal">{server.name}</span>
              {server.meta ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  {server.meta}
                </span>
              ) : null}
            </span>
          </Label>
        );
      })}
    </div>
  );
}
