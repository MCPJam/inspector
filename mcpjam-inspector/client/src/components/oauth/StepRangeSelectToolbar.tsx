import type { ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import type { StepRangeSelectControls } from "@/hooks/use-step-range-select";

interface StepRangeSelectToolbarProps {
  controls: StepRangeSelectControls;
  /** The view's existing "Copy all" button, shown outside select mode. */
  children: ReactNode;
}

/**
 * The "Select step" toggle and, in select mode, the selected count with
 * Cancel and "Copy N steps". Shared by the OAuth and XAA debuggers.
 */
export function StepRangeSelectToolbar({
  controls,
  children,
}: StepRangeSelectToolbarProps) {
  const { isSelecting, selectedCount, copyState } = controls;

  if (!isSelecting) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        {controls.available && (
          <Button
            variant="ghost"
            size="sm"
            onClick={controls.enter}
            className="h-8"
            title="Select steps to copy. Shift-click selects a range."
          >
            Select step
          </Button>
        )}
        {children}
      </div>
    );
  }

  const copyLabel =
    copyState === "error"
      ? "Copy failed"
      : copyState === "success"
        ? "Copied!"
        : `Copy ${selectedCount} step${selectedCount === 1 ? "" : "s"}`;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {selectedCount} selected
      </span>
      <Button variant="ghost" size="sm" onClick={controls.exit} className="h-8">
        Cancel
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void controls.copySelected()}
        disabled={selectedCount === 0}
        className="h-8"
      >
        {copyLabel}
      </Button>
    </div>
  );
}

/**
 * The checkbox drawn on a step header in select mode. It is decorative: the
 * header itself carries the checkbox role and handles clicks and keys, so the
 * whole row is the hit target and shift-click works anywhere on it.
 */
export function StepSelectIndicator({ checked }: { checked: boolean }) {
  return (
    <Checkbox
      checked={checked}
      tabIndex={-1}
      aria-hidden
      className="pointer-events-none mt-0.5"
    />
  );
}
