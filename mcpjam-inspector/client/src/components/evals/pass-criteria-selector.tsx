import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { useEffect, useRef, useState } from "react";

interface PassCriteriaSelectorProps {
  minimumPassRate: number;
  onMinimumPassRateChange: (rate: number) => void;
  /**
   * Suppress the inline "Minimum accuracy:" label so the caller can
   * provide its own row label (e.g. the suite settings sheet's
   * label/control split).
   */
  hideLabel?: boolean;
}

export function PassCriteriaSelector({
  minimumPassRate,
  onMinimumPassRateChange,
  hideLabel = false,
}: PassCriteriaSelectorProps) {
  const [editedValue, setEditedValue] = useState(minimumPassRate.toString());

  // The last prop value this component has reconciled with — either because it
  // arrived from outside, or because this field is about to report it. A move
  // away from it is news from elsewhere; a move back to it is this field's own
  // echo returning through the parent.
  const lastSeenRate = useRef(minimumPassRate);

  // True from the first keystroke until the edit is committed (blur, Enter) or
  // abandoned (Escape). Focus alone is deliberately not enough: someone who
  // tabs through the field without typing should still see an external change
  // land, and their blur must not re-commit the number that happened to be
  // sitting in the input.
  const isEditing = useRef(false);

  // Follow the prop when it moves for a reason OTHER than this input.
  //
  // The value used to be write-on-change, so the prop only ever moved because
  // this field had just moved it. Under a draft it also moves when the person
  // hits Discard, or when the suite changes underneath them — and without this
  // the input kept displaying a number the draft no longer holds, which is the
  // worst possible failure for a settings control: it says the setting is one
  // thing while the thing that gets saved is another. Re-blurring would then
  // re-commit the stale number as a fresh edit.
  useEffect(() => {
    if (minimumPassRate === lastSeenRate.current) return;
    // Record it either way, so a later move BACK to the old number still reads
    // as news rather than as this field's echo.
    lastSeenRate.current = minimumPassRate;
    // Half-typed text belongs to the person, not to whatever just arrived. They
    // are looking at the field, so their next blur wins over the new value.
    if (isEditing.current) return;
    setEditedValue(minimumPassRate.toString());
  }, [minimumPassRate]);

  const commit = () => {
    isEditing.current = false;
    const numValue = Number(editedValue);
    if (!isNaN(numValue)) {
      const clampedValue = Math.max(0, Math.min(100, numValue));
      lastSeenRate.current = clampedValue;
      onMinimumPassRateChange(clampedValue);
      setEditedValue(clampedValue.toString());
    } else {
      // Reset to current value if invalid
      setEditedValue(minimumPassRate.toString());
    }
  };

  // Escape gets there by blurring, and blurring is what commits — so the cancel
  // has to survive the blur event that fires synchronously inside the keydown,
  // where `editedValue` still holds the abandoned text.
  const cancelled = useRef(false);

  const handleBlur = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    commit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      // Just leave the field — the blur below IS the commit. Calling `commit`
      // here as well reported the same edit twice, once from each path.
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      cancelled.current = true;
      isEditing.current = false;
      setEditedValue(minimumPassRate.toString());
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {hideLabel ? null : (
        <Label
          htmlFor="pass-criteria"
          className="text-sm text-muted-foreground"
        >
          Minimum accuracy:
        </Label>
      )}
      <Input
        id="pass-criteria"
        type="number"
        min={0}
        max={100}
        value={editedValue}
        onChange={(e) => {
          isEditing.current = true;
          setEditedValue(e.target.value);
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="w-16 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-sm text-muted-foreground">%</span>
    </div>
  );
}
