/**
 * HarnessBuiltinToolsSection
 *
 * Selectable list of a harness's NATIVE built-in tools (Bash, Read, Edit, …) in
 * the Playground Tools panel. Selecting a row behaves like selecting a server
 * tool: the panel collapses the list and shows the tool's detail view + the top
 * "Run" button. For built-ins, "Run" asks the agent to call the tool (see
 * `useBuiltinToolRun`) — there is no API to fire a built-in tool call directly.
 *
 * Shared by both Tools-panel surfaces: `ToolList` (zero-server) and
 * `MultiServerToolsPaneInner` (active-server).
 */
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import { cn } from "@/lib/utils";

interface HarnessBuiltinToolsSectionProps {
  tools: HarnessBuiltinToolInfo[];
  /** Shared with the panel's search box so built-in rows filter together. */
  searchQuery: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

export function HarnessBuiltinToolsSection({
  tools,
  searchQuery,
  selectedKey,
  onSelect,
}: HarnessBuiltinToolsSectionProps) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) =>
      `${t.name} ${t.commonName ?? ""} ${t.description ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [tools, searchQuery]);

  if (tools.length === 0) return null;
  if (filtered.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Built-in tools
        </span>
        <span
          className="font-mono text-[9px] rounded bg-muted px-1 py-[1px] text-muted-foreground"
          title="These execute inside the harness sandbox via the agent's own loop. MCPJam can't call them directly — Run asks the agent to."
        >
          runs in sandbox
        </span>
      </div>
      <div className="space-y-0.5">
        {filtered.map((tool) => {
          const isSelected = selectedKey === tool.key;
          return (
            <button
              key={tool.key}
              type="button"
              onClick={() => onSelect(tool.key)}
              className={cn(
                "w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1",
                isSelected ? "bg-primary/10" : "hover:bg-muted/50",
              )}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <code className="text-xs font-mono font-medium truncate flex-1">
                  {tool.name}
                </code>
                {tool.toolUseKind && (
                  <span
                    className="font-mono text-[9px] rounded bg-accent px-1 py-[1px] text-accent-foreground shrink-0"
                    title="Tool use kind"
                  >
                    {tool.toolUseKind}
                  </span>
                )}
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              </div>
              {tool.description && (
                <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                  {tool.description}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
