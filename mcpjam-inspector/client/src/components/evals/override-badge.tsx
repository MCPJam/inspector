/**
 * Per-control override indicator chip + reset affordance for layered
 * eval-config fields (Phase 3).
 *
 * Two states:
 *   - "(suite default · X)" — local value is undefined/inheriting. Chip
 *     rendered secondary/greyed; the associated input is greyed/disabled
 *     upstream (callers thread `isInheriting` into the `disabled` prop of
 *     their input).
 *   - "(overriding · suite: X)" — local value differs from suite default.
 *     Chip rendered primary/highlighted; input is editable. A small reset
 *     button writes `undefined` (NOT the default value) so the layered
 *     resolver continues to inherit if the suite default later changes.
 *
 * Shared between the case-edit form and the run popover. The suite-edit
 * page is the source — it does not render this badge.
 */

import { RotateCcw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

interface OverrideBadgeProps {
  /**
   * True when the local layer's value is `undefined` (inheriting). When
   * false, the local value is an explicit override.
   *
   * Note: this is intentionally a boolean rather than `value === undefined`
   * because some callers (predicate-mode radio) have a 3-state semantic
   * where "inherit" is a meaningful enum value, not absence.
   */
  isInheriting: boolean;
  /**
   * Pretty-printed suite default label, e.g. "Strict order" / "Partial" /
   * "Unlimited" / "Replace suite defaults". Rendered after the dot.
   */
  suiteDefaultLabel: string;
  /**
   * Optional override-state label shown after "overriding · suite: …".
   * Defaults to just the suite label. Callers can pass a custom string if
   * the override semantic ("Replace" vs "Extend") matters.
   */
  overrideKindLabel?: string;
  /**
   * Called when the user clicks the reset affordance. Must write
   * `undefined` (not the default) so inheritance keeps tracking the suite.
   * If omitted, no reset button is rendered (used by read-only previews).
   */
  onReset?: () => void;
}

/**
 * Inline chip rendered next to a layered control's label. Keep this
 * component visual-only: state is computed by the caller (which already
 * knows the resolved values and field semantics).
 */
export function OverrideBadge({
  isInheriting,
  suiteDefaultLabel,
  overrideKindLabel,
  onReset,
}: OverrideBadgeProps) {
  if (isInheriting) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40",
          "px-2 py-0.5 text-[10px] font-medium leading-none text-muted-foreground",
        )}
        data-testid="override-badge-inheriting"
      >
        suite default · {suiteDefaultLabel}
      </span>
    );
  }

  // Overriding state. The chip itself is the reset affordance — clicking
  // anywhere inside it (including the icon button) reverts to inherit.
  const label = overrideKindLabel
    ? `overriding · ${overrideKindLabel} (suite: ${suiteDefaultLabel})`
    : `overriding · suite: ${suiteDefaultLabel}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border",
        "border-primary/40 bg-primary/10",
        "px-2 py-0.5 text-[10px] font-medium leading-none text-primary",
      )}
      data-testid="override-badge-overriding"
    >
      <span>{label}</span>
      {onReset ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // Tighter than the default ghost button so the icon sits cleanly
          // inside the chip's pill. The icon is the affordance — the chip
          // never has a separate "Reset" label, to keep the row compact.
          className="-mr-1 h-4 w-4 p-0 text-primary hover:bg-primary/15 hover:text-primary"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReset();
          }}
          title="Reset to suite default"
          aria-label="Reset to suite default"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      ) : null}
    </span>
  );
}
