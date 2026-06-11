import { useCallback, useMemo } from "react";
import { Label } from "@mcpjam/design-system/label";
import type { BuiltInToolCatalogEntry } from "@/hooks/useBuiltInToolCatalog";

/**
 * Presentational multi-checkbox picker for host-managed built-in tools.
 * Mirrors `ServerCheckboxList` (same file family): the parent owns the
 * catalog fetch + the empty-catalog gate, this just renders the toggles.
 */
export function BuiltInToolCheckboxList({
  label,
  selected,
  available,
  onChange,
  computerAttached = false,
}: {
  label: string;
  selected: string[];
  available: ReadonlyArray<BuiltInToolCatalogEntry>;
  onChange: (ids: string[]) => void;
  /**
   * Whether the host has a personal `computer` attached. Computer-backed
   * tools (`requiresComputer`) are disabled until it is — checking one
   * without the resource is the exact draft the backend rejects on save.
   */
  computerAttached?: boolean;
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
          const blockedOnComputer = Boolean(
            tool.requiresComputer && !computerAttached
          );
          return (
            <label
              key={tool.id}
              className={
                blockedOnComputer
                  ? "flex items-start gap-2 text-sm cursor-not-allowed opacity-60"
                  : "flex items-start gap-2 text-sm cursor-pointer"
              }
              title={
                blockedOnComputer
                  ? "Attach a personal computer to enable this tool"
                  : undefined
              }
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selectedSet.has(tool.id)}
                disabled={blockedOnComputer}
                onChange={() => toggle(tool.id, blockedOnComputer)}
              />
              <span className="grid">
                <span>{tool.displayLabel}</span>
                {tool.description ? (
                  <span className="text-xs text-muted-foreground">
                    {tool.description}
                  </span>
                ) : null}
                {blockedOnComputer ? (
                  <span className="text-xs text-amber-600 dark:text-amber-500">
                    Requires a personal computer (attach it above).
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
