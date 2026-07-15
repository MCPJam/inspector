import type { Tool } from "@modelcontextprotocol/client";
import { ChevronRight } from "lucide-react";
import { getToolVisibility } from "@/lib/mcp-ui/mcp-apps-utils";

export type ToolQualitySeverity = "error" | "warn";

export interface ToolQualityInfo {
  severity: ToolQualitySeverity;
  /** One human-readable label per finding (counts already inlined). */
  labels: string[];
}

interface ToolItemProps {
  tool: Tool;
  name: string;
  isSelected: boolean;
  onClick: () => void;
  quality?: ToolQualityInfo;
}

export function ToolItem({
  tool,
  name,
  isSelected,
  onClick,
  quality,
}: ToolItemProps) {
  const visibility = getToolVisibility(
    tool._meta as Record<string, unknown> | undefined
  );
  const visibilityLabel = `[${visibility.map((v) => `"${v}"`).join(", ")}]`;
  return (
    <div
      className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
        isSelected
          ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
          : "hover:shadow-sm"
      }`}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
              {name}
            </code>
            {quality && quality.labels.length > 0 && (
              <span
                title={quality.labels.join("\n")}
                aria-label={`${quality.labels.length} tool quality ${
                  quality.labels.length === 1 ? "issue" : "issues"
                }`}
                className={`inline-flex items-center justify-center rounded-full h-4 min-w-[1rem] px-1 text-[9px] font-semibold flex-shrink-0 ${
                  quality.severity === "error"
                    ? "bg-destructive/15 text-destructive"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                }`}
              >
                {quality.labels.length}
              </span>
            )}
          </div>
          {tool.description && (
            <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
              {tool.description}
            </p>
          )}
          <div
            className="font-mono text-[10px] text-muted-foreground mt-2"
            title={`SEP-1865 visibility: ${visibilityLabel}`}
          >
            visibility: {visibilityLabel}
          </div>
        </div>
        <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
      </div>
    </div>
  );
}
