import { useState } from "react";
import { ChevronDown, ChevronRight, Hammer, Loader2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { useAggregatedTools } from "@/hooks/use-aggregated-tools";
import { cn } from "@/lib/utils";

interface ToolsPaneProps {
  selectedServerNames: string[];
  /** Optional click handler — Phase 4 ships display-only; downstream phases wire execution. */
  onSelectTool?: (serverId: string, toolName: string) => void;
  selectedScopedKey?: string;
}

/**
 * Playground tools pane. Multi-server-aware: aggregates `listTools` across
 * the selected servers via `useAggregatedTools` and renders one collapsible
 * section per server. Matches the convention from
 * `evals/tool-choice-picker.tsx:204` — bare tool names with a server `<Badge>`
 * — but ensures a `(serverId, toolName)` tuple is what we pass to callers so
 * tool-name collisions across servers can be disambiguated.
 *
 * Phase 4 ships display-only (no form, no execute). When `AppBuilderTab` is
 * decomposed, its form + execute wiring will hang off `onSelectTool`.
 */
export function ToolsPane({
  selectedServerNames,
  onSelectTool,
  selectedScopedKey,
}: ToolsPaneProps) {
  const { toolsByServer, loadingByServer, errorByServer, collidingNames } =
    useAggregatedTools(selectedServerNames);

  if (selectedServerNames.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Select one or more servers to see their tools here.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {selectedServerNames.map((serverId) => {
        const tools = toolsByServer[serverId] ?? [];
        const loading = loadingByServer[serverId];
        const error = errorByServer[serverId];
        return (
          <ServerSection
            key={serverId}
            serverId={serverId}
            tools={tools}
            loading={loading}
            error={error}
            collidingNames={collidingNames}
            onSelectTool={onSelectTool}
            selectedScopedKey={selectedScopedKey}
          />
        );
      })}
    </div>
  );
}

interface ServerSectionProps {
  serverId: string;
  tools: Array<{ name: string; description?: string }>;
  loading?: boolean;
  error?: string;
  collidingNames: string[];
  onSelectTool?: (serverId: string, toolName: string) => void;
  selectedScopedKey?: string;
}

function ServerSection({
  serverId,
  tools,
  loading,
  error,
  collidingNames,
  onSelectTool,
  selectedScopedKey,
}: ServerSectionProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-accent"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Hammer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{serverId}</span>
        {loading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {tools.length}
          </Badge>
        )}
      </button>
      {expanded ? (
        <div className="ml-3 mt-0.5 space-y-0.5">
          {error ? (
            <div className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}
          {tools.length === 0 && !loading && !error ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              No tools.
            </div>
          ) : null}
          {tools.map((tool) => {
            const scopedKey = `${serverId}:${tool.name}`;
            const isSelected = selectedScopedKey === scopedKey;
            const isColliding = collidingNames.includes(tool.name);
            return (
              <button
                key={tool.name}
                type="button"
                onClick={() => onSelectTool?.(serverId, tool.name)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs",
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
                title={tool.description}
              >
                <span className="flex-1 truncate font-mono text-[11px]">
                  {tool.name}
                </span>
                {isColliding ? (
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-[9px] uppercase"
                  >
                    {shortenServerId(serverId)}
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function shortenServerId(serverId: string): string {
  if (serverId.length <= 12) return serverId;
  return `${serverId.slice(0, 10)}…`;
}
