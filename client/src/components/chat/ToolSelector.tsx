import React, { useState, useRef, useEffect } from "react";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChevronDown, ChevronRight, Wrench, Check } from "lucide-react";
import { cn } from "@/lib/utils/request/utils";

export interface ToolSelection {
  enabledTools: Set<string>;
  enabledServers: Set<string>;
}

export interface ServerInfo {
  name: string;
  tools: Tool[];
  toolCount: number;
}

interface ToolSelectorProps {
  tools: Tool[];
  toolSelection: ToolSelection;
  onSelectionChange: (selection: ToolSelection) => void;
  serverInfo: ServerInfo[];
  loading?: boolean;
}

export const ToolSelector: React.FC<ToolSelectorProps> = ({
  tools,
  toolSelection,
  onSelectionChange,
  serverInfo,
  loading = false,
}) => {
  const [showSelector, setShowSelector] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(
    new Set(),
  );
  const selectorRef = useRef<HTMLDivElement>(null);

  const availableTools = serverInfo
    .filter((server) => toolSelection.enabledServers.has(server.name))
    .flatMap((server) => server.tools);

  const totalAvailableTools = availableTools.length;
  const enabledToolCount = toolSelection.enabledTools.size;
  const allAvailableToolsEnabled =
    enabledToolCount === totalAvailableTools && totalAvailableTools > 0;
  const someToolsDisabled = enabledToolCount < totalAvailableTools;

  const toggleServer = (serverName: string, enabled: boolean) => {
    const newEnabledServers = new Set(toolSelection.enabledServers);
    const newEnabledTools = new Set(toolSelection.enabledTools);

    const serverTools =
      serverInfo.find((s) => s.name === serverName)?.tools || [];

    if (enabled) {
      newEnabledServers.add(serverName);
      serverTools.forEach((tool) => newEnabledTools.add(tool.name));
    } else {
      newEnabledServers.delete(serverName);
      serverTools.forEach((tool) => newEnabledTools.delete(tool.name));
    }

    onSelectionChange({
      enabledTools: newEnabledTools,
      enabledServers: newEnabledServers,
    });
  };

  const toggleTool = (
    toolName: string,
    enabled: boolean,
    serverName: string,
  ) => {
    if (!toolSelection.enabledServers.has(serverName)) return;

    const newEnabledTools = new Set(toolSelection.enabledTools);
    if (enabled) {
      newEnabledTools.add(toolName);
    } else {
      newEnabledTools.delete(toolName);
    }

    onSelectionChange({
      enabledTools: newEnabledTools,
      enabledServers: toolSelection.enabledServers,
    });
  };

  const toggleExpandedServer = (serverName: string) => {
    setExpandedServers((prev) => {
      const newSet = new Set(prev);

      if (newSet.has(serverName)) {
        newSet.delete(serverName);
      } else {
        newSet.add(serverName);
      }

      return newSet;
    });
  };

  const toggleAllServers = (enabled: boolean) => {
    const newEnabledServers = enabled
      ? new Set(serverInfo.map((s) => s.name))
      : new Set<string>();
    const newEnabledTools = enabled
      ? new Set(tools.map((t) => t.name))
      : new Set<string>();

    onSelectionChange({
      enabledTools: newEnabledTools,
      enabledServers: newEnabledServers,
    });
  };

  // Handle clicks outside dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        selectorRef.current &&
        !selectorRef.current.contains(event.target as Node)
      ) {
        setShowSelector(false);
      }
    };

    if (showSelector) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showSelector]);

  return (
    <div className="relative" ref={selectorRef}>
      <button
        onClick={() => setShowSelector(!showSelector)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700",
          someToolsDisabled && "border-amber-300 dark:border-amber-600",
        )}
        disabled={loading}
      >
        <Wrench className="w-3 h-3 text-slate-400" />
        <span className="text-slate-700 dark:text-slate-200 font-medium">
          Tools
        </span>
        {someToolsDisabled && (
          <span className="text-xs px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400 rounded">
            {enabledToolCount}/{totalAvailableTools}
          </span>
        )}
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {showSelector && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg z-50 max-h-96 overflow-y-auto">
          <div className="p-3 border-b border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Select Tools
              </span>
              <div>
                <button
                  onClick={() => toggleAllServers(true)}
                  className="text-xs px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300"
                  disabled={allAvailableToolsEnabled}
                >
                  All
                </button>
              </div>
            </div>
          </div>

          <div className="py-2">
            {serverInfo.map((server) => {
              const serverEnabled = toolSelection.enabledServers.has(
                server.name,
              );
              const serverExpanded = expandedServers.has(server.name);
              const serverTools = server.tools;
              const enabledServerToolCount = serverTools.filter((tool) =>
                toolSelection.enabledTools.has(tool.name),
              ).length;
              const allServerToolsEnabled =
                enabledServerToolCount === serverTools.length;

              return (
                <div key={server.name} className="mb-2">
                  {/* Server Toggle */}
                  <div className="relative">
                    <label className="flex items-center gap-3 pl-4 pr-12 py-2 min-w-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <div className="relative">
                        <input
                          type="checkbox"
                          checked={serverEnabled}
                          onChange={(e) =>
                            toggleServer(server.name, e.target.checked)
                          }
                          className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                        />
                        {serverEnabled && allServerToolsEnabled && (
                          <Check className="w-3 h-3 text-blue-600 absolute top-0.5 left-0.5 pointer-events-none" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium break-words text-slate-900 dark:text-slate-100">
                          {server.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {enabledServerToolCount}/{serverTools.length} tools
                        </div>
                      </div>
                    </label>

                    <button
                      onClick={() => toggleExpandedServer(server.name)}
                      className="absolute top-1/2 right-3 -translate-y-1/2 text-xs p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-600 dark:text-slate-300"
                    >
                      {serverExpanded ? (
                        <ChevronDown className="w-3 h-3 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-3 h-3 text-slate-400" />
                      )}
                    </button>
                  </div>

                  {/* Server Tools */}
                  {serverExpanded && (
                    <div className="space-y-1">
                      {serverTools.map((tool) => {
                        const toolEnabled = toolSelection.enabledTools.has(
                          tool.name,
                        );

                        return (
                          <div
                            key={tool.name}
                            className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                          >
                            <label className="pl-12 pr-4 py-1.5 flex items-center gap-3 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={toolEnabled}
                                onChange={(e) =>
                                  toggleTool(
                                    tool.name,
                                    e.target.checked,
                                    server.name,
                                  )
                                }
                                disabled={!serverEnabled}
                                className="w-3 h-3 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-slate-800 dark:text-slate-200 truncate">
                                  {tool.name}
                                </div>
                                {tool.description && (
                                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                    {tool.description}
                                  </div>
                                )}
                              </div>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {serverInfo.length === 0 && (
            <div className="px-4 py-8 text-center text-slate-500 dark:text-slate-400 text-sm">
              No servers connected
            </div>
          )}
        </div>
      )}
    </div>
  );
};
