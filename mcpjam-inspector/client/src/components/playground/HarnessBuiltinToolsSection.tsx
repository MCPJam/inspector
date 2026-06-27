/**
 * HarnessBuiltinToolsSection
 *
 * Read-only list of a harness's NATIVE built-in tools (Bash, Read, Edit, …),
 * shown in the Playground Tools panel so a harness host (e.g. Claude Code)
 * doesn't look tool-less when no MCP server is attached.
 *
 * GUARDRAIL: these tools run INSIDE the harness sandbox via its own agent loop
 * — they are NOT callable through MCPJam. So rows are display-only: clicking a
 * row only toggles its input-schema (it never selects/runs the tool). There is
 * deliberately no "Run" affordance.
 *
 * Shared by both Tools-panel surfaces: `ToolList` (zero-server) and
 * `MultiServerToolsPaneInner` (active-server).
 */
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import { cn } from "@/lib/utils";

interface HarnessBuiltinToolsSectionProps {
  tools: HarnessBuiltinToolInfo[];
  /** Shared with the panel's search box so built-in rows filter together. */
  searchQuery: string;
}

export function HarnessBuiltinToolsSection({
  tools,
  searchQuery,
}: HarnessBuiltinToolsSectionProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

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
  // When a search hides every built-in row, drop the whole section (header
  // included) so it doesn't read as an empty harness.
  if (filtered.length === 0) return null;

  const toggle = (key: string, canExpand: boolean) => {
    if (!canExpand) return;
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Built-in tools
        </span>
        <span
          className="font-mono text-[9px] rounded bg-muted px-1 py-[1px] text-muted-foreground"
          title="These execute inside the harness sandbox via its own agent loop. They are not callable through MCPJam."
        >
          runs in sandbox
        </span>
      </div>
      <div className="space-y-0.5">
        {filtered.map((tool) => {
          const canExpand = !!tool.inputSchema;
          const isOpen = expandedKeys.has(tool.key);
          return (
            <div key={tool.key}>
              <button
                type="button"
                onClick={() => toggle(tool.key, canExpand)}
                aria-expanded={canExpand ? isOpen : undefined}
                // Display-only: no selection/run, just schema disclosure.
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1",
                  canExpand ? "cursor-pointer hover:bg-muted/50" : "cursor-default",
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
                  {canExpand && (
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                        isOpen && "rotate-90",
                      )}
                    />
                  )}
                </div>
                {tool.description && (
                  <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                    {tool.description}
                  </p>
                )}
              </button>
              {isOpen && tool.inputSchema && (
                <div className="px-3 pb-2">
                  <SchemaViewer schema={tool.inputSchema} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
