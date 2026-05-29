import { cn } from "@/lib/utils";
import type { EvalIteration } from "../types";
import { computeIterationResult } from "../pass-criteria";

const MAX_DOTS = 12;

interface PassDotRowProps {
  iterations: EvalIteration[];
}

export function PassDotRow({ iterations }: PassDotRowProps) {
  const shown = iterations.slice(0, MAX_DOTS);
  const overflow = iterations.length - shown.length;

  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {shown.map((iter) => {
        const result = computeIterationResult(iter);
        return (
          <span
            key={iter._id}
            title={result}
            className={cn(
              "inline-block size-2 rounded-full",
              result === "passed" && "bg-green-500",
              result === "failed" && "bg-red-500",
              result === "cancelled" && "bg-gray-400",
              (result === "pending") && "bg-yellow-400",
            )}
          />
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground">+{overflow}</span>
      )}
    </div>
  );
}
