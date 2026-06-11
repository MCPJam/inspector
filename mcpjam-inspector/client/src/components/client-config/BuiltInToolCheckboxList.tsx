import { useCallback, useMemo } from "react";
import { Label } from "@mcpjam/design-system/label";
import type { BuiltInToolCatalogEntry } from "@/hooks/useBuiltInToolCatalog";

/**
 * Presentational multi-checkbox picker for host-managed built-in tools.
 * Mirrors `ServerCheckboxList` (same file family): the parent owns the
 * catalog fetch + the empty-catalog gate, this just renders the toggles.
 *
 * Computer-backed tools (`requiresComputer`, e.g. `bash`) are gated to mirror
 * the backend's write-time invariant in the UI: they can't be *added* unless
 * a personal computer is attached (or are wholly disallowed on eval suites).
 * A tool that is already selected but currently blocked stays togglable so
 * the user can always REMOVE a stale invalid id — only adding is blocked.
 */
export function BuiltInToolCheckboxList({
  label,
  selected,
  available,
  onChange,
  computerAttached = false,
  computerToolsDisallowed = false,
  readOnly = false,
}: {
  label: string;
  selected: string[];
  available: ReadonlyArray<BuiltInToolCatalogEntry>;
  onChange: (ids: string[]) => void;
  /** Whether the host has a personal `computer` attached. */
  computerAttached?: boolean;
  /**
   * When true, computer-backed tools can never be used on this surface at all
   * (eval suites — the backend aborts eval runs whose host carries a
   * computer). They render blocked regardless of `computerAttached`.
   */
  computerToolsDisallowed?: boolean;
  /** Disable every checkbox (no edits) — for read-only editor surfaces. */
  readOnly?: boolean;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = useCallback(
    (id: string, disabled: boolean) => {
      if (disabled) return;
      const next = new Set(selectedSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(Array.from(next));
    },
    [selectedSet, onChange]
  );

  if (available.length === 0) {
    return (
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground mt-1">
          No built-in tools available.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="grid gap-1.5 max-h-40 overflow-y-auto rounded border px-2 py-2">
        {available.map((tool) => {
          const isSelected = selectedSet.has(tool.id);
          let blockReason: string | null = null;
          if (tool.requiresComputer) {
            if (computerToolsDisallowed) {
              blockReason = "Not available for eval suites.";
            } else if (!computerAttached) {
              blockReason = "Requires a personal computer (attach it above).";
            }
          }
          const blocked = blockReason !== null;
          // Read-only disables everything. Otherwise: a blocked tool that is
          // already selected stays removable (so a stale invalid id like
          // `bash` saved without a computer can always be unchecked) — only
          // ADDING a blocked tool is disabled.
          const disabled = readOnly || (blocked && !isSelected);
          return (
            <label
              key={tool.id}
              className={
                disabled
                  ? "flex items-start gap-2 text-sm cursor-not-allowed opacity-60"
                  : "flex items-start gap-2 text-sm cursor-pointer"
              }
              title={disabled ? blockReason ?? undefined : undefined}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={isSelected}
                disabled={disabled}
                onChange={() => toggle(tool.id, disabled)}
              />
              <span className="grid">
                <span>{tool.displayLabel}</span>
                {tool.description ? (
                  <span className="text-xs text-muted-foreground">
                    {tool.description}
                  </span>
                ) : null}
                {blocked ? (
                  <span className="text-xs text-amber-600 dark:text-amber-500">
                    {blockReason}
                    {isSelected ? " Uncheck to remove." : ""}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
