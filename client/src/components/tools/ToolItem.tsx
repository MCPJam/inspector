import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChevronRight } from "lucide-react";

interface ToolItemProps {
  tool: Tool;
  name: string;
  isSelected: boolean;
  onClick: () => void;
}

export function ToolItem({ tool, name, isSelected, onClick }: ToolItemProps) {
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
          </div>
          {tool.description && (
            <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
              {tool.description}
            </p>
          )}
        </div>
        <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
      </div>
    </div>
  );
}
