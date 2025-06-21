import {
  CompatibilityCallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useState } from "react";
import { ConnectionStatus } from "@/lib/constants";
import ToolRunCard from "./ToolRunCard";
import { McpJamRequest } from "@/lib/requestTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Bookmark,
  Trash2,
  Calendar,
  Star,
  Edit2,
  CopyPlus,
  ChevronDown,
  ChevronRight,
  Search,
  Play,
  Code2,
  Folder,
  FolderOpen,
} from "lucide-react";
import { RequestStorage } from "@/utils/requestStorage";
import {
  sortRequests,
  createMcpJamRequest,
  getRequestsForClient,
} from "@/utils/requestUtils";

// Enhanced tool interface with category information
interface EnhancedTool extends Tool {
  category?: string;
  isExpanded?: boolean;
}

// Category grouping interface
interface ToolCategory {
  name: string;
  tools: EnhancedTool[];
  isExpanded: boolean;
  count: number;
}

// Helper function to extract category from tool name
const extractCategory = (toolName: string): string => {
  // Common patterns for categorization
  const patterns = [
    // Pattern: prefix_category_action
    /^([a-zA-Z]+)_([a-zA-Z_]+)_[a-zA-Z_]+$/,
    // Pattern: category_action
    /^([a-zA-Z_]+)_[a-zA-Z_]+$/,
    // Pattern: single word
    /^([a-zA-Z]+)$/,
  ];

  for (const pattern of patterns) {
    const match = toolName.match(pattern);
    if (match) {
      return match[1].replace(/_/g, " ").toLowerCase();
    }
  }

  return "other";
};

// Helper function to group tools by category
const groupToolsByCategory = (tools: Tool[]): ToolCategory[] => {
  const categoryMap = new Map<string, EnhancedTool[]>();

  tools.forEach((tool) => {
    const category = extractCategory(tool.name);
    const enhancedTool: EnhancedTool = { ...tool, category, isExpanded: false };
    
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push(enhancedTool);
  });

  // Convert map to sorted array
  const categories = Array.from(categoryMap.entries())
    .map(([name, tools]) => ({
      name,
      tools,
      isExpanded: true, // Start with categories expanded
      count: tools.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return categories;
};

const EnhancedToolsTab = ({
  tools,
  listTools,
  clearTools,
  callTool,
  selectedTool,
  setSelectedTool,
  nextCursor,
  connectionStatus,
  selectedServerName,
}: {
  tools: Tool[];
  listTools: () => void;
  clearTools: () => void;
  callTool: (name: string, params: Record<string, unknown>) => Promise<void>;
  selectedTool: Tool | null;
  setSelectedTool: (tool: Tool | null) => void;
  toolResult: CompatibilityCallToolResult | null;
  nextCursor: ListToolsResult["nextCursor"];
  error: string | null;
  connectionStatus: ConnectionStatus;
  selectedServerName: string;
}) => {
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [savedRequests, setSavedRequests] = useState<McpJamRequest[]>([]);
  const [loadedRequest, setLoadedRequest] = useState<McpJamRequest | null>(null);
  const [renamingRequestId, setRenamingRequestId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Load saved requests
  useEffect(() => {
    const loadSavedRequests = () => {
      const allRequests = RequestStorage.loadRequests();
      const clientRequests = selectedServerName
        ? getRequestsForClient(allRequests, selectedServerName)
        : [];
      const sortedRequests = sortRequests(clientRequests, "updatedAt", "desc");
      setSavedRequests(sortedRequests);
    };

    loadSavedRequests();

    const handleStorageChange = () => {
      loadSavedRequests();
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("requestSaved", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("requestSaved", handleStorageChange);
    };
  }, [selectedServerName]);

  // Group tools by category when tools change
  useEffect(() => {
    const groupedCategories = groupToolsByCategory(tools);
    setCategories(groupedCategories);
  }, [tools]);

  // Clear tools when server changes
  useEffect(() => {
    clearTools();
    setSelectedTool(null);
  }, [selectedServerName]);

  useEffect(() => {
    if (connectionStatus === "connected") {
      listTools();
    }
  }, [connectionStatus]);

  // Filter categories and tools based on search
  const filteredCategories = categories
    .map((category) => ({
      ...category,
      tools: category.tools.filter((tool) =>
        tool.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tool.description?.toLowerCase().includes(searchTerm.toLowerCase())
      ),
    }))
    .filter((category) => 
      selectedCategory ? category.name === selectedCategory : 
      category.tools.length > 0
    );

  const toggleCategoryExpansion = (categoryName: string) => {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.name === categoryName
          ? { ...cat, isExpanded: !cat.isExpanded }
          : cat
      )
    );
  };

  const toggleToolExpansion = (categoryName: string, toolName: string) => {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.name === categoryName
          ? {
              ...cat,
              tools: cat.tools.map((tool) =>
                tool.name === toolName
                  ? { ...tool, isExpanded: !tool.isExpanded }
                  : tool
              ),
            }
          : cat
      )
    );
  };

  const handleApplyTool = (tool: Tool) => {
    setSelectedTool(tool);
    // Scroll to tool run card if needed
    const toolRunCard = document.querySelector('[data-tool-run-card]');
    if (toolRunCard) {
      toolRunCard.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const renderToolCard = (tool: EnhancedTool, categoryName: string) => {
    const parameters = tool.inputSchema.properties
      ? Object.keys(tool.inputSchema.properties)
      : [];

    return (
      <div key={tool.name} className="border-l-2 border-gray-200 dark:border-gray-700 ml-4 pl-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg p-3 shadow-sm border border-gray-100 dark:border-gray-800 hover:shadow-md hover:border-blue-200 dark:hover:border-blue-800 transition-all duration-200 group">
          {/* Tool header */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2 flex-1">
              <button
                onClick={() => toggleToolExpansion(categoryName, tool.name)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
              >
                {tool.isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                )}
              </button>
              <span className="text-lg">🛠️</span>
              <span className="font-mono text-xs bg-gradient-to-r from-slate-100 to-gray-100 dark:from-slate-800 dark:to-gray-800 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-200 font-medium shadow-sm">
                {tool.name}
              </span>
              {parameters.length > 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-600 font-medium">
                  {parameters.length} param{parameters.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <Button
              onClick={() => handleApplyTool(tool)}
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs bg-blue-50 hover:bg-blue-100 dark:bg-blue-950 dark:hover:bg-blue-900 border-blue-200 dark:border-blue-800"
            >
              <Play className="w-3 h-3 mr-1" />
              Apply
            </Button>
          </div>

          {/* Tool description */}
          <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed mb-2">
            {tool.description}
          </p>

          {/* Expanded details */}
          {tool.isExpanded && (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="space-y-2">
                {/* Parameters */}
                {parameters.length > 0 && (
                  <div>
                    <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1 flex items-center">
                      <Code2 className="w-3 h-3 mr-1" />
                      Parameters
                    </h5>
                    <div className="bg-gray-50 dark:bg-gray-800 rounded p-2">
                      <div className="space-y-1">
                        {parameters.map((param) => {
                          const paramSchema = tool.inputSchema.properties?.[param] as {
                            type?: string;
                            description?: string;
                          };
                          return (
                            <div key={param} className="text-xs">
                              <span className="font-mono text-blue-600 dark:text-blue-400">
                                {param}
                              </span>
                              <span className="text-gray-500 dark:text-gray-400 ml-2">
                                ({paramSchema?.type || 'unknown'})
                              </span>
                              {paramSchema?.description && (
                                <p className="text-gray-600 dark:text-gray-300 ml-2 mt-1">
                                  {paramSchema.description}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Tool schema */}
                <div>
                  <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    Schema
                  </h5>
                  <div className="bg-gray-50 dark:bg-gray-800 rounded p-2">
                    <pre className="text-xs text-gray-600 dark:text-gray-400 overflow-x-auto">
                      {JSON.stringify(tool.inputSchema, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCategorySection = (category: ToolCategory) => {
    return (
      <div key={category.name} className="mb-4">
        {/* Category header */}
        <div
          className="flex items-center justify-between p-3 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer hover:bg-gradient-to-r hover:from-gray-100 hover:to-gray-200 dark:hover:from-gray-700 dark:hover:to-gray-600 transition-all duration-200"
          onClick={() => toggleCategoryExpansion(category.name)}
        >
          <div className="flex items-center space-x-2">
            {category.isExpanded ? (
              <FolderOpen className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            ) : (
              <Folder className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            )}
            <h3 className="font-semibold text-gray-800 dark:text-gray-200 capitalize">
              {category.name.replace(/_/g, " ")}
            </h3>
            <span className="text-xs bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 px-2 py-1 rounded-full">
              {category.count}
            </span>
          </div>
          {category.isExpanded ? (
            <ChevronDown className="w-5 h-5 text-gray-500" />
          ) : (
            <ChevronRight className="w-5 h-5 text-gray-500" />
          )}
        </div>

        {/* Category tools */}
        {category.isExpanded && (
          <div className="mt-2 space-y-2">
            {category.tools.map((tool) => renderToolCard(tool, category.name))}
          </div>
        )}
      </div>
    );
  };

  const savedRequestSection = () => {
    const handleDeleteRequest = (requestId: string) => {
      if (confirm("Are you sure you want to delete this saved request?")) {
        RequestStorage.removeRequest(requestId);
        setSavedRequests((prev) => prev.filter((req) => req.id !== requestId));
      }
    };

    const handleLoadRequest = (request: McpJamRequest) => {
      const matchingTool = tools.find((tool) => tool.name === request.toolName);
      if (matchingTool) {
        setSelectedTool(matchingTool);
      }
      setLoadedRequest(request);
      setTimeout(() => setLoadedRequest(null), 100);
    };

    const handleRenameRequest = (requestId: string, currentName: string) => {
      setRenamingRequestId(requestId);
      setRenameValue(currentName);
    };

    const handleSaveRename = (requestId: string) => {
      if (renameValue.trim()) {
        RequestStorage.updateRequest(requestId, { name: renameValue.trim() });
        setSavedRequests((prev) =>
          prev.map((req) =>
            req.id === requestId ? { ...req, name: renameValue.trim() } : req,
          ),
        );
      }
      setRenamingRequestId(null);
      setRenameValue("");
    };

    const handleCancelRename = () => {
      setRenamingRequestId(null);
      setRenameValue("");
    };

    const handleDuplicateRequest = (request: McpJamRequest) => {
      const duplicatedRequest = createMcpJamRequest({
        name: `${request.name} (Copy)`,
        description: request.description,
        toolName: request.toolName,
        tool: request.tool,
        parameters: request.parameters,
        tags: request.tags || [],
        isFavorite: false,
        clientId: selectedServerName,
      });

      RequestStorage.addRequest(duplicatedRequest);
      setSavedRequests((prev) => [duplicatedRequest, ...prev]);
    };

    const formatDate = (date: Date) => {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    };

    return (
      <div className="flex flex-col bg-card border border-border rounded-lg overflow-hidden">
        <div className="p-3 border-b border-border/50 bg-muted/30">
          <div className="flex items-center space-x-2">
            <Bookmark className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">
              Saved Requests
            </h3>
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {savedRequests.length}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 max-h-96">
          {savedRequests.length === 0 ? (
            <div className="text-center py-8">
              <Bookmark className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No saved requests</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Save requests from the tool runner
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {savedRequests.map((request) => (
                <div
                  key={request.id}
                  className="group bg-muted/30 hover:bg-muted/50 border border-border/30 rounded-lg p-2.5 transition-all duration-200 cursor-pointer"
                  onClick={() =>
                    renamingRequestId !== request.id &&
                    handleLoadRequest(request)
                  }
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      {renamingRequestId === request.id ? (
                        <div className="flex items-center space-x-1">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSaveRename(request.id);
                              }
                              if (e.key === "Escape") {
                                handleCancelRename();
                              }
                            }}
                            className="h-6 text-xs"
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <h4 className="text-xs font-medium text-foreground truncate">
                              {request.name}
                            </h4>
                            {request.isFavorite && (
                              <Star className="w-3 h-3 text-yellow-500 fill-current" />
                            )}
                          </div>
                          <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                            <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
                              {request.toolName}
                            </span>
                            <Calendar className="w-3 h-3" />
                            <span>{formatDate(request.updatedAt)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRenameRequest(request.id, request.name);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                      >
                        <Edit2 className="w-3 h-3" />
                      </Button>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDuplicateRequest(request);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                      >
                        <CopyPlus className="w-3 h-3" />
                      </Button>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRequest(request.id);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-[2fr_3fr_3fr] gap-4 h-full">
      {/* Saved Requests Section */}
      {savedRequestSection()}

      {/* Enhanced Tools List */}
      <div className="bg-card rounded-lg shadow border border-border overflow-hidden">
        <div className="p-4 border-b border-border/50 bg-muted/30">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground">Tools</h3>
            <div className="flex gap-1">
              <Button
                variant="outline"
                onClick={listTools}
                disabled={!nextCursor && tools.length > 0}
                className="h-7 px-2 text-xs"
              >
                Load Tools
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  clearTools();
                  setSelectedTool(null);
                }}
                disabled={tools.length === 0}
                className="h-7 px-2 text-xs"
              >
                Clear
              </Button>
            </div>
          </div>

          {/* Search and filters */}
          {tools.length > 0 && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search tools by name or description..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-8 text-sm"
                />
              </div>
              
              {/* Category filter */}
              <div className="flex flex-wrap gap-1">
                <Button
                  variant={selectedCategory === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedCategory(null)}
                  className="h-6 px-2 text-xs"
                >
                  All ({tools.length})
                </Button>
                {categories.map((category) => (
                  <Button
                    key={category.name}
                    variant={selectedCategory === category.name ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedCategory(
                      selectedCategory === category.name ? null : category.name
                    )}
                    className="h-6 px-2 text-xs capitalize"
                  >
                    {category.name.replace(/_/g, " ")} ({category.count})
                  </Button>
                ))}
              </div>

              {(searchTerm || selectedCategory) && (
                <p className="text-xs text-muted-foreground">
                  Showing {filteredCategories.reduce((acc, cat) => acc + cat.tools.length, 0)} of {tools.length} tools
                </p>
              )}
            </div>
          )}
        </div>

        <div className="p-4 overflow-y-auto max-h-96">
          {filteredCategories.length > 0 ? (
            <div className="space-y-4">
              {filteredCategories.map((category) => renderCategorySection(category))}
            </div>
          ) : searchTerm ? (
            <div className="text-center py-8 text-muted-foreground">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No tools found matching "{searchTerm}"</p>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Code2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No tools available</p>
              <p className="text-xs mt-1">Load tools to get started</p>
            </div>
          )}
        </div>
      </div>

      {/* Tool Runner */}
      <div data-tool-run-card>
        <ToolRunCard
          selectedTool={selectedTool}
          callTool={callTool}
          loadedRequest={loadedRequest}
          selectedServerName={selectedServerName}
        />
      </div>
    </div>
  );
};

export default EnhancedToolsTab; 