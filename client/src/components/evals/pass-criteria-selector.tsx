import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PassCriteriaSelectorProps {
  minimumPassRate: number;
  onMinimumPassRateChange: (rate: number) => void;
}

export function PassCriteriaSelector({
  minimumPassRate,
  onMinimumPassRateChange,
}: PassCriteriaSelectorProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div>
        <h3 className="text-sm font-medium">Pass/Fail Criteria</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Define when this evaluation run should be considered successful
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Minimum Pass Rate (%)</Label>
        <Input
          type="number"
          min={0}
          max={100}
          value={minimumPassRate}
          onChange={(e) =>
            onMinimumPassRateChange(
              Math.max(0, Math.min(100, Number(e.target.value)))
            )
          }
        />
        <p className="text-xs text-muted-foreground">
          Suite passes if {minimumPassRate}% or more of all test iterations pass
        </p>
      </div>
    </div>
  );
}
