import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { WorkspaceVisibility } from "@/state/app-types";
import { Globe, Lock } from "lucide-react";

interface WorkspaceVisibilityBadgeProps {
  visibility?: WorkspaceVisibility | null;
  compact?: boolean;
  className?: string;
}

export function WorkspaceVisibilityBadge({
  visibility,
  compact = false,
  className,
}: WorkspaceVisibilityBadgeProps) {
  const workspaceVisibility = visibility ?? "public";
  const isPublic = workspaceVisibility === "public";
  const Icon = isPublic ? Globe : Lock;
  const label = compact
    ? isPublic
      ? "Public"
      : "Private"
    : isPublic
      ? "Public workspace"
      : "Private workspace";

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border",
        isPublic
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
        className,
      )}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </Badge>
  );
}
