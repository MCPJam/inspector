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

  // Follow the prop when it moves for a reason OTHER than this input.
  //
  // The value used to be write-on-change, so the prop only ever moved because
  // this field had just moved it. Under a draft it also moves when the person
  // hits Discard, or when the suite changes underneath them — and without this
  // the input kept displaying a number the draft no longer holds, which is the
  // worst possible failure for a settings control: it says the setting is one
  // thing while the thing that gets saved is another. Re-blurring would then
  // re-commit the stale number as a fresh edit.
  //
  // Guarded on the value the field itself last reported, so an in-flight edit
  // is never yanked out from under someone mid-typing.
  const lastReported = useRef(minimumPassRate);
  useEffect(() => {
    if (minimumPassRate === lastReported.current) return;
    lastReported.current = minimumPassRate;
    setEditedValue(minimumPassRate.toString());
  }, [minimumPassRate]);

  const handleBlur = () => {
    const numValue = Number(editedValue);
    if (!isNaN(numValue)) {
      const clampedValue = Math.max(0, Math.min(100, numValue));
      lastReported.current = clampedValue;
      onMinimumPassRateChange(clampedValue);
      setEditedValue(clampedValue.toString());
    } else {
      // Reset to current value if invalid
      setEditedValue(minimumPassRate.toString());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBlur();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
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
        onChange={(e) => setEditedValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="w-16 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-sm text-muted-foreground">%</span>
    </div>
  );
}
