/**
 * ToolList
 *
 * Displays searchable list of available tools. Surfaces:
 *   - Server tools (passed in via `tools` prop)
 */

import { useMemo } from "react";
import { Plug, RefreshCw } from "lucide-react";
import type { Tool } from "@modelcontextprotocol/client";
import { Button } from "@mcpjam/design-system/button";
import { useAppNavigate, routePaths } from "@/lib/app-navigation";
import { SearchInput } from "../ui/search-input";
import {
  detectUIType,
  getToolVisibility,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { AppToolsSection } from "@/components/playground/AppToolsSection";
import type { AppPaneGroup } from "@/components/playground/app-pane-tools";
import { HarnessBuiltinToolsSection } from "@/components/playground/HarnessBuiltinToolsSection";
import { BrowserToolsSection } from "@/components/playground/BrowserToolsSection";
import { ToolSourceHeader } from "@/components/playground/ToolSourceHeader";
import { WEBMCP_TOOL_NAME_PREFIX } from "@/shared/declared-tools";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import type { BrowserToolsState } from "@/hooks/useBrowserTools";

interface ToolListProps {
  appGroups?: AppPaneGroup[];
  selectedAppKey?: string | null;
  onSelectApp?: (key: string) => void;
  previewedHarnessId?: string | null;
  tools: Record<string, Tool>;
  toolNames: string[];
  filteredToolNames: string[];
  selectedToolName: string | null;
  fetchingTools: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSelectTool: (name: string) => void;
  onCollapseList: () => void;
  /** Harness native built-in tools. Present for harness hosts. */
  builtinTools?: HarnessBuiltinToolInfo[];
  /** Currently-selected built-in tool key (so its row highlights). */
  selectedBuiltinKey?: string | null;
  /** True when the previewed host runs its harness on THIS machine. */
  builtinToolsRunLocally?: boolean;
  /** Select a built-in tool (drives the same detail+Run flow as server tools). */
  onSelectBuiltin?: (key: string) => void;
  /**
   * The agent browser's tools (the six `browser_*` plus the current page's
   * WebMCP ones), when the previewed host attaches a browser. Selecting a
   * row opens the same detail + Run flow as a server tool; Run asks the agent.
   */
  browserTools?: BrowserToolsState;
  selectedBrowserKey?: string | null;
  onSelectBrowser?: (key: string) => void;
  /**
   * Whether at least one MCP server is connected. When false, the empty state
   * says so and offers a way out instead of blaming a server that isn't there.
   * Defaults to true so callers that don't track connections keep the old copy.
   */
  hasConnectedServer?: boolean;
  /**
   * Connect a server in place. Callers without their own Add Server modal omit
   * it and the empty state keeps navigating to Servers.
   */
  onAddServerRequested?: () => void;
}

export function ToolList({
  appGroups = [],
  selectedAppKey,
  onSelectApp,
  previewedHarnessId,
  tools,
  toolNames,
  filteredToolNames,
  selectedToolName,
  fetchingTools,
  searchQuery,
  onSearchQueryChange,
  onSelectTool,
  onCollapseList,
  builtinTools = [],
  selectedBuiltinKey = null,
  builtinToolsRunLocally = false,
  onSelectBuiltin,
  browserTools,
  selectedBrowserKey = null,
  onSelectBrowser,
  hasConnectedServer = true,
  onAddServerRequested,
}: ToolListProps) {
  const navigate = useAppNavigate();
  const appToolCount = onSelectApp
    ? appGroups.reduce((count, group) => count + group.tools.length, 0)
    : 0;
  const filteredAppToolCount = onSelectApp
    ? appGroups.reduce(
        (count, group) =>
          count +
          group.tools.filter((tool) =>
            `${group.appName} ${group.serverId} ${tool.rawName} ${tool.description ?? ""}`
              .toLowerCase()
              .includes(searchQuery.trim().toLowerCase()),
          ).length,
        0,
      )
    : 0;

  // Built-in (harness-native) tools filter against the same search box; the
  // section component owns the actual filtering, so we only need a count here
  // for the empty-state.
  const filteredBuiltinCount = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return builtinTools.length;
    return builtinTools.filter((t) =>
      `${t.name} ${t.commonName ?? ""} ${t.description ?? ""}`
        .toLowerCase()
        .includes(q),
    ).length;
  }, [builtinTools, searchQuery]);

  // Same job for the browser's own tools: the section filters itself, this is
  // only for the empty state. Its PAGE tools are deliberately not counted — a
  // page's tools come and go as the browser navigates, and a list that emptied
  // itself into "no server connected" the moment somebody browsed away would be
  // reporting the wrong thing about a browser that is working.
  const filteredBrowserCount = useMemo(() => {
    const tools = browserTools?.tools ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tools.length;
    return tools.filter((t) =>
      `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q),
    ).length;
  }, [browserTools, searchQuery]);

  const filteredPageCount = useMemo(() => {
    const pageTools = browserTools?.page?.ok ? browserTools.page.tools : [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return pageTools.length;
    return pageTools.filter((tool) =>
      `${WEBMCP_TOOL_NAME_PREFIX}${tool.name} ${tool.name} ${tool.description ?? ""}`
        .toLowerCase()
        .includes(q),
    ).length;
  }, [browserTools, searchQuery]);

  // Local Browser permission is a row of its own: until it is granted the
  // browser's tools are withheld, and the section is where Allow lives.
  const browserConsentShown =
    (browserTools?.localConsent || browserTools?.catalogError) &&
    !searchQuery.trim()
      ? 1
      : 0;
  const totalShown =
    browserConsentShown +
    filteredToolNames.length +
    filteredAppToolCount +
    filteredBuiltinCount +
    filteredBrowserCount +
    filteredPageCount;
  // Mirrors every source `totalShown` counts, unfiltered — built-ins and the
  // browser included. Omitting them let a search that hides a harness's
  // built-ins fall through to the no-server copy, which would be reporting the
  // wrong reason for an empty list (the rail's zero-server fallback passes
  // built-ins and `hasConnectedServer={false}` together, so that pairing is
  // reachable — and a browser-only host is exactly that pairing).
  const hasNoTools =
    toolNames.length === 0 &&
    appToolCount === 0 &&
    builtinTools.length === 0 &&
    (browserTools?.tools.length ?? 0) === 0 &&
    !browserTools?.localConsent &&
    !browserTools?.catalogError;

  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <SearchInput
          value={searchQuery}
          onValueChange={onSearchQueryChange}
          placeholder="Search tools..."
        />
      </div>

      {/* Tool List */}
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {fetchingTools && appToolCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">Loading tools...</p>
          </div>
        ) : totalShown === 0 ? (
          <div className="text-center py-8 px-2 space-y-3">
            <p className="text-xs text-muted-foreground">
              {!hasNoTools
                ? "No tools match your search"
                : hasConnectedServer
                  ? "No tools found. Try refreshing and make sure the server is running."
                  : "No server connected yet. Connect one to load its tools and use them in chat."}
            </p>
            {hasNoTools && !hasConnectedServer && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (onAddServerRequested) {
                    onAddServerRequested();
                    return;
                  }
                  navigate(routePaths.servers);
                }}
              >
                <Plug className="h-3.5 w-3.5" />
                Connect a server
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {browserTools ? (
              <BrowserToolsSection
                tools={browserTools.tools}
                page={browserTools.page}
                searchQuery={searchQuery}
                selectedKey={selectedBrowserKey}
                onSelect={onSelectBrowser}
                localConsent={browserTools.localConsent}
                catalogError={browserTools.catalogError}
                onRetryCatalog={browserTools.refreshPage}
              />
            ) : null}
            {onSelectApp ? (
              <AppToolsSection
                groups={appGroups}
                searchQuery={searchQuery}
                selectedKey={selectedAppKey}
                onSelect={onSelectApp}
                previewedHarnessId={previewedHarnessId}
              />
            ) : null}
            {filteredToolNames.length > 0 ? (
              <ToolSourceHeader title="Servers">
                <div className="space-y-0.5">
                  {filteredToolNames.map((name) => {
                    const tool = tools[name];
                    const isSelected = selectedToolName === name;
                    const uiType = detectUIType(tool._meta, undefined);
                    const visibility = getToolVisibility(
                      tool._meta as Record<string, unknown> | undefined,
                    );
                    const visibilityLabel = `[${visibility
                      .map((v) => `"${v}"`)
                      .join(", ")}]`;

                    return (
                      <button
                        key={name}
                        onClick={() => {
                          if (isSelected) {
                            onCollapseList();
                          } else {
                            onSelectTool(name);
                          }
                        }}
                        className={`w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 ${
                          isSelected
                            ? "cursor-pointer bg-primary/10"
                            : "cursor-pointer hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <code className="text-xs font-mono font-medium truncate flex-1">
                            {name}
                          </code>
                        </div>
                        {tool.description && (
                          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                            {tool.description}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-2">
                          {(uiType === UIType.OPENAI_SDK ||
                            uiType === UIType.OPENAI_SDK_AND_MCP_APPS) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center">
                                  <img
                                    src="/openai_logo.png"
                                    alt="ChatGPT Apps"
                                    className="h-3.5 w-3.5 object-contain opacity-60"
                                  />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs">ChatGPT Apps</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {(uiType === UIType.MCP_APPS ||
                            uiType === UIType.OPENAI_SDK_AND_MCP_APPS ||
                            uiType === UIType.MCP_UI) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center">
                                  <img
                                    src="/mcp.svg"
                                    alt="MCP Apps"
                                    className="h-3.5 w-3.5 object-contain opacity-60"
                                  />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs">
                                  {uiType === UIType.MCP_UI
                                    ? "MCP UI"
                                    : "MCP Apps"}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <span
                            className="font-mono text-[10px] text-muted-foreground"
                            title={`SEP-1865 visibility: ${visibilityLabel}`}
                          >
                            visibility: {visibilityLabel}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ToolSourceHeader>
            ) : null}
            {onSelectBuiltin && (
              <HarnessBuiltinToolsSection
                tools={builtinTools}
                searchQuery={searchQuery}
                selectedKey={selectedBuiltinKey}
                onSelect={onSelectBuiltin}
                localExecution={builtinToolsRunLocally}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
