import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { EvaluatorTone } from "./evaluator-library-types";

const TONE_CLASS: Record<EvaluatorTone, string> = {
  tools: "bg-info/10 text-info",
  answer: "bg-success/10 text-success",
  errors: "bg-primary/10 text-primary",
  security: "bg-destructive/10 text-destructive",
};

export function EvaluatorPresetIcon({
  icon: Icon,
  tone,
  className,
}: {
  icon: LucideIcon;
  tone: EvaluatorTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}
