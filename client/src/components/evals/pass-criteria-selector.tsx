import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

interface PassCriteriaSelectorProps {
  minimumPassRate: number;
  onMinimumPassRateChange: (rate: number) => void;
}

export function PassCriteriaSelector({
  minimumPassRate,
  onMinimumPassRateChange,
}: PassCriteriaSelectorProps) {
  const [editedValue, setEditedValue] = useState(minimumPassRate.toString());

  const handleBlur = () => {
    const numValue = Number(editedValue);
    if (!isNaN(numValue)) {
      const clampedValue = Math.max(0, Math.min(100, numValue));
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
      <Label htmlFor="pass-criteria" className="text-sm text-muted-foreground">
        Minimum accuracy:
      </Label>
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
