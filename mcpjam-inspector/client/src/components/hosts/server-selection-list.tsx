import { type ReactNode, useMemo } from "react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
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
};

/**
 * Pure controlled list of server checkboxes. No data fetching, no
 * business rules — callers own `selectedIds` and the toggle handler.
 *
 * Used by the suite/chatbox attachment editor's Servers tab and any
 * future surface that needs the same per-server selection UX. Stay
 * structural — visual flourishes (status dots, transport badges,
 * connection state) layer on top via a richer wrapper component, not
 * here.
 */
export function ServerSelectionList({
  servers,
  selectedIds,
  onToggle,
  disabled = false,
  emptyState,
  ariaLabel = "Servers",
}: ServerSelectionListProps) {
  const stableSelected = useMemo(
    () => new Set(selectedIds),
    [selectedIds],
  );

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
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex flex-col gap-1"
    >
      {servers.map((server) => {
        const checked = stableSelected.has(server.id);
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
              onCheckedChange={(next) =>
                onToggle(server.id, next === true)
              }
              disabled={disabled}
              aria-label={server.name}
            />
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
