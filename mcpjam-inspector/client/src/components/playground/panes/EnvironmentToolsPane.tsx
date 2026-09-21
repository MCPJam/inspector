/**
 * EnvironmentToolsPane
 *
 * The Tools rail body while the Playground is in ENVIRONMENT mode. The
 * ordinary panes read the browser's own MCP connections — which environment
 * mode never creates (the backend connects per turn) — so they'd report
 * "No tools found" while tools visibly execute in chat. This pane instead
 * reads `GET /api/web/environments/:id/tools`, the server-side one-shot
 * listing over the same connections a turn uses, so what it shows is what a
 * message will actually run against (plugin-contributed servers included).
 *
 * Deliberately read-only in v1: execution in environment mode goes through
 * chat, and the rail's browser-connection run machinery
 * (`state.executeTool`) cannot reach these servers. Expanding a row shows
 * the tool's description and input schema.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  useEnvironmentTools,
  type EnvironmentServerTools,
} from "@/hooks/use-environment-tools";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { SearchInput } from "@/components/ui/search-input";
import { ErrorCard } from "@/components/ui/error-card";
import {
  describeEnvironmentError,
  isNoServersError,
} from "@/lib/environment-error";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";

interface EnvironmentToolsPaneProps {
  projectId: string;
  environmentId: string;
}

export function EnvironmentToolsPane({
  projectId,
  environmentId,
}: EnvironmentToolsPaneProps) {
  // The reactive row's `revision` makes a live edit (another tab, a
  // collaborator) refetch — same signal the environment preview keys on.
  const environments = useProjectEnvironments(projectId);
  const revision = useMemo(
    () =>
      environments?.find((env) => env.environmentId === environmentId)
        ?.revision ?? null,
    [environments, environmentId],
  );
  const { servers, isLoading, error, refresh } = useEnvironmentTools(
    projectId,
    environmentId,
    revision,
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const flat = useMemo(
    () =>
      (servers ?? []).flatMap((server) =>
        server.tools.map((tool) => ({ server, tool })),
      ),
    [servers],
  );
  const collidingNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const entry of flat) {
      seen.set(entry.tool.name, (seen.get(entry.tool.name) ?? 0) + 1);
    }
    return new Set(
      Array.from(seen.entries())
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [flat]);
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return flat;
    const query = searchQuery.trim().toLowerCase();
    return flat.filter((entry) =>
      `${entry.tool.name} ${entry.tool.description ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [flat, searchQuery]);
  const failedServers = useMemo(
    () => (servers ?? []).filter((server) => server.error),
    [servers],
  );

  return (
    <div
      className="h-full min-w-0 flex flex-col bg-background overflow-hidden"
      data-testid="environment-tools-pane"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 flex-shrink-0">
        <span className="text-xs font-medium">
          Tools{" "}
          <span className="text-muted-foreground">
            {servers ? flat.length : ""}
          </span>
        </span>
        <button
          type="button"
          onClick={refresh}
          className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label="Refresh environment tools"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
          />
        </button>
      </div>

      <div className="px-3 py-2 flex-shrink-0">
        <SearchInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search tools..."
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {error ? (
          <div className="py-6 px-2">
            <ErrorCard
              error={describeEnvironmentError(error)}
              variant="inline"
              // A zero-servers environment is not a transient failure, so Retry
              // would only fail again. Send the user where the fix is instead.
              {...(isNoServersError(error)
                ? {
                    action: {
                      label: "Open Servers",
                      onClick: () => navigateApp(routePaths.servers),
                    },
                  }
                : { onRetry: refresh })}
            />
          </div>
        ) : isLoading && !servers ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">
              Listing the environment's tools…
            </p>
          </div>
        ) : (
          <>
            {failedServers.map((server) => (
              <ServerErrorRow key={server.serverId} server={server} />
            ))}
            {filtered.length === 0 ? (
              <div className="text-center py-8 px-4">
                <p className="text-xs text-muted-foreground">
                  {flat.length === 0
                    ? failedServers.length > 0
                      ? "No tools could be listed."
                      : "This environment's servers expose no tools."
                    : "No tools match your search"}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filtered.map(({ server, tool }) => {
                  const key = `${server.serverId}\x00${tool.name}`;
                  const isExpanded = expandedKey === key;
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        onClick={() => setExpandedKey(isExpanded ? null : key)}
                        aria-expanded={isExpanded}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1",
                          isExpanded
                            ? "cursor-pointer bg-primary/10"
                            : "cursor-pointer hover:bg-muted/50",
                        )}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <code className="text-xs font-mono font-medium truncate flex-1">
                            {tool.name}
                          </code>
                          {collidingNames.has(tool.name) ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 px-1 text-[9px] uppercase"
                            >
                              {server.name.length > 10
                                ? `${server.name.slice(0, 8)}…`
                                : server.name}
                            </Badge>
                          ) : null}
                          <ChevronDown
                            className={cn(
                              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                              isExpanded && "rotate-180",
                            )}
                            aria-hidden
                          />
                        </div>
                        {!isExpanded && tool.description ? (
                          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                            {tool.description}
                          </p>
                        ) : null}
                      </button>
                      {isExpanded ? (
                        <div className="mx-3 mb-2 mt-1 flex flex-col gap-2">
                          <p className="text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {server.name}
                            </span>
                            {tool.description ? ` — ${tool.description}` : ""}
                          </p>
                          {tool.inputSchema ? (
                            <SchemaViewer schema={tool.inputSchema} />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground flex-shrink-0">
        Environment servers connect automatically on every message — run these
        tools by chatting.
      </p>
    </div>
  );
}

function ServerErrorRow({ server }: { server: EnvironmentServerTools }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          // Focusable so keyboard users can open the tooltip and read the
          // underlying error text — the row itself is not an action.
          tabIndex={0}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid={`environment-tools-error-${server.serverId}`}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{server.name}: couldn't list tools</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 break-words">
        {server.error}
      </TooltipContent>
    </Tooltip>
  );
}
