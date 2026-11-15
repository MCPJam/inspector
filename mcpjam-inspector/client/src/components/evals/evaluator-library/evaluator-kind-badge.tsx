import { Badge } from "@mcpjam/design-system/badge";
import {
  Code2,
  Copy,
  GitBranch,
  Library,
  ListChecks,
  ListTodo,
  Scale,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  EvaluatorMethod,
  EvaluatorOrigin,
  OwaspId,
} from "./evaluator-library-types";

type KindPresentation = { label: string; icon: LucideIcon; className: string };

/**
 * Method and origin are separate badges on purpose: a library copy can use any
 * method, and a reader scanning a suite needs both answers.
 */
const METHOD: Record<EvaluatorMethod, KindPresentation> = {
  assertions: {
    label: "Assertions",
    icon: ListChecks,
    className: "text-muted-foreground",
  },
  judge: {
    label: "Judge prompt",
    icon: Scale,
    className: "border-info/40 bg-info/5 text-info",
  },
  decision: {
    label: "Decision questions",
    icon: ListTodo,
    className: "border-success/40 bg-success/5 text-success",
  },
  code: { label: "Code", icon: Code2, className: "bg-muted text-foreground" },
};

const ORIGIN: Record<EvaluatorOrigin, KindPresentation> = {
  library: {
    label: "Library",
    icon: Library,
    className: "border-primary/40 bg-primary/5 text-primary",
  },
  "library-copy": {
    label: "Library copy",
    icon: Copy,
    className: "border-primary/40 bg-primary/5 text-primary",
  },
  github: {
    label: "From GitHub",
    icon: GitBranch,
    className: "bg-muted text-foreground",
  },
};

export type EvaluatorKindBadgeProps =
  | { method: EvaluatorMethod; origin?: never }
  | { origin: EvaluatorOrigin; method?: never };

export function EvaluatorKindBadge(props: EvaluatorKindBadgeProps) {
  const kind = props.method ? METHOD[props.method] : ORIGIN[props.origin];
  const Icon = kind.icon;
  return (
    <Badge variant="outline" className={cn("font-medium", kind.className)}>
      <Icon aria-hidden />
      {kind.label}
    </Badge>
  );
}

/** Only security evaluators carry OWASP tags. */
export function OwaspTag({ ids }: { ids: readonly OwaspId[] }) {
  if (ids.length === 0) return null;
  return (
    <Badge variant="outline" className="font-mono text-muted-foreground">
      <span className="sr-only">OWASP MCP Top 10: </span>
      {ids.join(" · ")}
    </Badge>
  );
}
