/**
 * ToolList
 *
 * Displays searchable list of available tools. Surfaces:
 *   - Server tools (passed in via `tools` prop)
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { RefreshCw } from "lucide-react";
import type { Tool } from "@modelcontextprotocol/client";
import { SearchInput } from "../ui/search-input";
import {
  detectUIType,
  getToolVisibility,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mcpjam/design-system/tooltip";
import { useAppToolsRegistry } from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { HarnessBuiltinToolsSection } from "@/components/playground/HarnessBuiltinToolsSection";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

interface AppEntry {
  alias: string;
  rawName: string;
  appName: string;
  description?: string;
  readOnly: boolean;
}

interface ToolListProps {
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
  /** Select a built-in tool (drives the same detail+Run flow as server tools). */
  onSelectBuiltin?: (key: string) => void;
}

export function ToolList({
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
  onSelectBuiltin,
}: ToolListProps) {
  // App-provided tools are widget-lifecycle. Pull them out of the registry
  // as a flat list of `AppEntry`. `useShallow` keeps the selector stable
  // across renders that didn't actually change the array.
  const { aliases, instancesByBridgeId } = useAppToolsRegistry(
    useShallow((s) => ({
      aliases: s.aliases,
      instancesByBridgeId: s.instancesByBridgeId,
    }))
  );
  const appEntries = useMemo<AppEntry[]>(() => {
    const aliasByBridgeAndName = new Map<string, string>();
    for (const [alias, info] of aliases.entries()) {
      aliasByBridgeAndName.set(`${info.bridgeId}\0${info.rawName}`, alias);
    }
    const out: AppEntry[] = [];
    for (const inst of instancesByBridgeId.values()) {
      for (const tool of inst.tools) {
        const alias = aliasByBridgeAndName.get(`${inst.bridgeId}\0${tool.name}`);
        if (!alias) continue;
        out.push({
          alias,
          rawName: tool.name,
          appName: inst.appName,
          description: tool.description,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
    }
    return out;
  }, [aliases, instancesByBridgeId]);

  // Apply the same search box to app entries (server entries are already
  // filtered upstream into `filteredToolNames`).
  const filteredAppEntries = useMemo(() => {
    if (!searchQuery.trim()) return appEntries;
    const q = searchQuery.toLowerCase();
    return appEntries.filter(
      (e) =>
        e.rawName.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.appName.toLowerCase().includes(q),
    );
  }, [appEntries, searchQuery]);

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

  const totalShown =
    filteredToolNames.length + filteredAppEntries.length + filteredBuiltinCount;

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
        {fetchingTools ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin mb-2" />
            <p className="text-xs text-muted-foreground">Loading tools...</p>
          </div>
        ) : totalShown === 0 ? (
          <div className="text-center py-8 space-y-4">
            <p className="text-xs text-muted-foreground">
              {toolNames.length === 0 && appEntries.length === 0
                ? "No tools found. Try refreshing and make sure the server is running."
                : "No tools match your search"}
            </p>
          </div>
        ) : (
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
                            {uiType === UIType.MCP_UI ? "MCP UI" : "MCP Apps"}
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
            {filteredAppEntries.map((entry) => {
                const isSelected = selectedToolName === entry.alias;
                return (
                  <button
                    key={entry.alias}
                    onClick={() => {
                      if (isSelected) {
                        onCollapseList();
                      } else {
                        onSelectTool(entry.alias);
                      }
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 ${
                      isSelected
                        ? "cursor-pointer bg-primary/10"
                        : "cursor-pointer hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <code className="text-xs font-mono font-medium truncate">
                        {entry.rawName}
                      </code>
                      <span
                        className="font-mono text-[10px] bg-accent text-accent-foreground px-1.5 py-[1px] rounded"
                        title={`App-provided by ${entry.appName} (alias: ${entry.alias})`}
                      >
                        from {entry.appName}
                      </span>
                    </div>
                    {entry.description && (
                      <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                        {entry.description}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-2">
                      <span
                        className="font-mono text-[10px] text-muted-foreground"
                        title="SEP-1865 app-provided tool"
                      >
                        readOnly: {entry.readOnly ? "true" : "false"}
                      </span>
                    </div>
                  </button>
                );
              })}
            {onSelectBuiltin && (
              <HarnessBuiltinToolsSection
                tools={builtinTools}
                searchQuery={searchQuery}
                selectedKey={selectedBuiltinKey}
                onSelect={onSelectBuiltin}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
