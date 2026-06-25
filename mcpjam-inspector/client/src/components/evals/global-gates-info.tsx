import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import {
  GLOBAL_GATES_SECTION_HELP,
  globalGateDescription,
  globalGateDetail,
  type PredicateKind,
} from "@/shared/predicate-kinds";

export function InfoHint({
  label,
  children,
  className,
  side = "top",
  align = "center",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-3" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className="max-w-[280px] px-2.5 py-2"
      >
        <div className="space-y-1 text-xs leading-snug">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}

export function GlobalGatesSectionInfoHint({
  className,
  side = "top",
}: {
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <InfoHint
      label="About global gates"
      className={className}
      side={side}
      align="start"
    >
      {GLOBAL_GATES_SECTION_HELP.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </InfoHint>
  );
}

export function GlobalGateKindInfoHint({
  kind,
  className,
  side = "top",
}: {
  kind: PredicateKind;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const description = globalGateDescription(kind);
  const detail = globalGateDetail(kind);
  if (!description && !detail) return null;

  return (
    <InfoHint
      label={description ?? "About this gate"}
      className={className}
      side={side}
      align="start"
    >
      {description ? (
        <p className="font-medium text-foreground">{description}</p>
      ) : null}
      {detail ? <p>{detail}</p> : null}
    </InfoHint>
  );
}
