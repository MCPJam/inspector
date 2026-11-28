import { Badge } from "@mcpjam/design-system/badge";
import { Library, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvaluatorOrigin } from "./evaluator-library-types";

type KindPresentation = { label: string; icon: LucideIcon; className: string };

const ORIGIN: Record<EvaluatorOrigin, KindPresentation> = {
  library: {
    label: "Library",
    icon: Library,
    className: "border-primary/40 bg-primary/5 text-primary",
  },
};

/** Where an evaluator in a suite came from. */
export function EvaluatorKindBadge({ origin }: { origin: EvaluatorOrigin }) {
  const kind = ORIGIN[origin];
  const Icon = kind.icon;
  return (
    <Badge variant="outline" className={cn("font-medium", kind.className)}>
      <Icon aria-hidden />
      {kind.label}
    </Badge>
  );
}
