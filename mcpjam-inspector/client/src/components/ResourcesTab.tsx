import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  FolderOpen,
  File,
  RefreshCw,
  ChevronRight,
  Eye,
  PanelLeftClose,
  FileCode,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  MCPServerConfig,
  type MCPReadResourceResult,
  type MCPResource,
  type MCPResourceTemplate,
} from "@mcpjam/sdk";
import {
  listResources,
  readResource as readResourceApi,
} from "@/lib/apis/mcp-resources-api";
import { listResourceTemplates as listResourceTemplatesApi } from "@/lib/apis/mcp-resource-templates-api";
import { SelectedToolHeader } from "./ui-playground/SelectedToolHeader";
import { Input } from "./ui/input";
import { parseTemplate } from "url-template";

interface ResourcesTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

// RFC 6570 compliant URI template parameter extraction
function extractTemplateParameters(uriTemplate: string): string[] {
  const params = new Set<string>();
  const paramRegex = /\{[+#./;?&]?([^}]+)\}/g;
  let match;

  while ((match = paramRegex.exec(uriTemplate)) !== null) {
    const variables = match[1].replace(/^[+#./;?&]/, "").split(",");
    variables.forEach((v) => {
      const varName = v.split(":")[0].replace(/\*$/, "").trim();
      if (varName) params.add(varName);
    });
  }

  return Array.from(params);
}

// RFC 6570 compliant URI template expansion
function buildUriFromTemplate(
  uriTemplate: string,
  params: Record<string, string>,
): string {
  const template = parseTemplate(uriTemplate);
  return template.expand(params);
}

export function ResourcesTab({ serverConfig, serverName }: ResourcesTabProps) {
  const [activeTab, setActiveTab] = useState<"resources" | "templates">(
    "resources",
  );
  // Resources state
  const [resources, setResources] = useState<MCPResource[]>([]);
  const [selectedResource, setSelectedResource] = useState<string>("");
  const [resourceContent, setResourceContent] =
    useState<MCPReadResourceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingResources, setFetchingResources] = useState(false);
  const [error, setError] = useState<string>("");
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  // Templates state
  const [templates, setTemplates] = useState<MCPResourceTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [fetchingTemplates, setFetchingTemplates] = useState(false);
  const [templateOverrides, setTemplateOverrides] = useState<
    Record<string, string>
  >({});

  // Panel state
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Derived data
  const selectedResourceData = useMemo(() => {
    return (
      resources.find((resource) => resource.uri === selectedResource) ?? null
    );
  }, [resources, selectedResource]);

  const selectedTemplateData = useMemo(() => {
    return (
      templates.find((template) => template.uriTemplate === selectedTemplate) ??
      null
    );
  }, [templates, selectedTemplate]);

  const templateParams = useMemo(() => {
    if (selectedTemplateData?.uriTemplate) {
      const paramNames = extractTemplateParameters(
        selectedTemplateData.uriTemplate,
      );
      return paramNames.map((name) => ({
        name,
        value: templateOverrides[name] ?? "",
      }));
    }
    return [];
  }, [selectedTemplateData?.uriTemplate, templateOverrides]);

  // Fetch resources
  useEffect(() => {
    if (serverConfig && serverName) {
      fetchResources();
      fetchTemplates();
    }
  }, [serverConfig, serverName]);

  const fetchResources = async (cursor?: string, append = false) => {
    if (!serverName) return;

    if (append) {
      setLoadingMore(true);
    } else {
      setFetchingResources(true);
      setError("");
      setResources([]);
      setSelectedResource("");
      setResourceContent(null);
      setNextCursor(undefined);
    }

    try {
      const result = await listResources(serverName, cursor);
      const serverResources: MCPResource[] = Array.isArray(result.resources)
        ? result.resources
        : [];

      if (append) {
        setResources((prev) => [...prev, ...serverResources]);
      } else {
        setResources(serverResources);
        if (serverResources.length === 0) {
          setSelectedResource("");
          setResourceContent(null);
        } else if (
          !serverResources.some((resource) => resource.uri === selectedResource)
        ) {
          setResourceContent(null);
        }
      }
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(`Network error fetching resources: ${err}`);
    } finally {
      setFetchingResources(false);
      setLoadingMore(false);
    }
  };

  const fetchTemplates = async () => {
    if (!serverName) return;

    setFetchingTemplates(true);

    try {
      const serverTemplates = await listResourceTemplatesApi(serverName);
      setTemplates(serverTemplates);
    } catch (err) {
      // Templates may not be supported - just set empty
      setTemplates([]);
    } finally {
      setFetchingTemplates(false);
    }
  };

  const loadMoreResources = useCallback(async () => {
    if (loadingMore) return;
    if (!nextCursor) return;

    try {
      await fetchResources(nextCursor, true);
    } catch (err) {
      // Error is already handled in fetchResources
    }
  }, [nextCursor, loadingMore]);

  // Intersection observer for pagination
  useEffect(() => {
    if (!sentinelRef.current) return;

    const element = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry.isIntersecting) return;
      if (!nextCursor || loadingMore) return;

      loadMoreResources();
    });

    observer.observe(element);

    return () => {
      observer.unobserve(element);
      observer.disconnect();
    };
  }, [nextCursor, loadingMore, loadMoreResources]);

  // Read resource
  const readResource = async (uri: string) => {
    if (!serverName) return;
    setLoading(true);
    setError("");

    try {
      const data = await readResourceApi(serverName, uri);
      setResourceContent(data?.content ?? null);
    } catch (err) {
      setError(`Error reading resource: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  // Read template
  const readTemplate = async () => {
    if (!selectedTemplate || !serverName) return;

    setLoading(true);
    setError("");

    try {
      const uri = getResolvedUri();
      const data = await readResourceApi(serverName, uri);
      setResourceContent(data?.content ?? null);
    } catch (err) {
      setError(`Error reading resource: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const updateParamValue = (paramName: string, value: string) => {
    setTemplateOverrides((prev) => ({ ...prev, [paramName]: value }));
  };

  const getResolvedUri = (): string => {
    if (!selectedTemplateData) return "";
    const params: Record<string, string> = {};
    templateParams.forEach((param) => {
      if (param.value !== "") {
        params[param.name] = param.value;
      }
    });
    return buildUriFromTemplate(selectedTemplateData.uriTemplate, params);
  };

  // Handle Enter key to read resource globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !loading) {
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        if (activeTab === "resources" && selectedResource) {
          readResource(selectedResource);
        } else if (activeTab === "templates" && selectedTemplate) {
          readTemplate();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedResource, selectedTemplate, loading, activeTab]);

  // Handle input Enter key for templates
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      readTemplate();
    }
  };

  const handleRefresh = () => {
    if (activeTab === "resources") {
      fetchResources();
    } else {
      fetchTemplates();
    }
  };

  const handleRead = () => {
    if (activeTab === "resources" && selectedResource) {
      readResource(selectedResource);
    } else if (activeTab === "templates" && selectedTemplate) {
      readTemplate();
    }
  };

  const canRead =
    activeTab === "resources" ? !!selectedResource : !!selectedTemplate;
  const isFetching =
    activeTab === "resources" ? fetchingResources : fetchingTemplates;

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No Server Selected"
        description="Connect to an MCP server to browse and explore its available resources."
      />
    );
  }

  const sidebarContent = (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* App Builder-style Header */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Tabs */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                setActiveTab("resources");
                setSelectedTemplate("");
                setResourceContent(null);
              }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "resources"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Resources
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {resources.length}
              </span>
            </button>
            <button
              onClick={() => {
                setActiveTab("templates");
                setSelectedResource("");
                setResourceContent(null);
              }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "templates"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Templates
              {templates.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-70">
                  {templates.length}
                </span>
              )}
            </button>
          </div>

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={handleRefresh}
              variant="ghost"
              size="sm"
              disabled={isFetching}
              className="h-7 w-7 p-0"
              title="Refresh"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              onClick={() => setIsSidebarVisible(false)}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Read button - only for templates since resources auto-read */}
          {activeTab === "templates" && (
            <Button
              onClick={handleRead}
              disabled={loading || !canRead}
              size="sm"
              className="h-8 px-3 text-xs ml-auto"
            >
              {loading ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
              <span className="ml-1">{loading ? "Reading" : "Read"}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Content area - show detail view when item is selected */}
      {activeTab === "resources" && selectedResource && selectedResourceData ? (
        // Resource detail view - minimal since response shows in center panel
        <div className="flex-1 flex flex-col min-h-0">
          <SelectedToolHeader
            toolName={selectedResourceData.name || selectedResource}
            description={selectedResourceData.description}
            onExpand={() => setSelectedResource("")}
            onClear={() => setSelectedResource("")}
          />
        </div>
      ) : activeTab === "templates" &&
        selectedTemplate &&
        selectedTemplateData ? (
        // Template parameters view
        <div className="flex-1 flex flex-col min-h-0">
          <SelectedToolHeader
            toolName={selectedTemplateData.name || selectedTemplate}
            description={selectedTemplateData.description}
            onExpand={() => setSelectedTemplate("")}
            onClear={() => setSelectedTemplate("")}
          />

          {/* URI template */}
          <div className="px-3 py-2 bg-muted/40 border-b border-border">
            <code className="text-[10px] font-mono text-muted-foreground break-all block">
              {getResolvedUri() || selectedTemplateData.uriTemplate}
            </code>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-3 space-y-4">
              {templateParams.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <p className="text-xs text-muted-foreground font-medium">
                    No parameters required
                  </p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Click Read to fetch this resource
                  </p>
                </div>
              ) : (
                templateParams.map((param) => (
                  <div key={param.name} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                          {param.name}
                        </code>
                        <div
                          className="w-1.5 h-1.5 bg-amber-400 dark:bg-amber-500 rounded-full"
                          title="Required parameter"
                        />
                      </div>
                      <Badge
                        variant="secondary"
                        className="text-[10px] font-mono"
                      >
                        string
                      </Badge>
                    </div>
                    <Input
                      type="text"
                      value={param.value}
                      onChange={(e) =>
                        updateParamValue(param.name, e.target.value)
                      }
                      onKeyDown={handleInputKeyDown}
                      placeholder={`Enter ${param.name}`}
                      className="h-8 text-xs"
                    />
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      ) : (
        // List view
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2 pb-16">
              {activeTab === "resources" ? (
                // Resources list
                <>
                  {fetchingResources ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                        <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                      </div>
                      <p className="text-xs text-muted-foreground font-semibold mb-1">
                        Loading resources...
                      </p>
                    </div>
                  ) : resources.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-sm text-muted-foreground">
                        No resources available
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1">
                        {resources.map((resource) => (
                          <div
                            key={resource.uri}
                            className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                              selectedResource === resource.uri
                                ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                                : "hover:shadow-sm"
                            }`}
                            onClick={() => {
                              setSelectedResource(resource.uri);
                              readResource(resource.uri);
                            }}
                          >
                            <div className="flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <File className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                  <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border truncate">
                                    {resource.name}
                                  </code>
                                </div>
                                {resource.description && (
                                  <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
                                    {resource.description}
                                  </p>
                                )}
                              </div>
                              <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                            </div>
                          </div>
                        ))}
                      </div>
                      <div ref={sentinelRef} className="h-4" />
                      {loadingMore && (
                        <div className="flex items-center justify-center py-3 text-xs text-muted-foreground gap-2">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          <span>Loading more resources…</span>
                        </div>
                      )}
                      {!nextCursor && resources.length > 0 && !loadingMore && (
                        <div className="text-center py-3 text-xs text-muted-foreground">
                          No more resources
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                // Templates list
                <>
                  {fetchingTemplates ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                        <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                      </div>
                      <p className="text-xs text-muted-foreground font-semibold mb-1">
                        Loading templates...
                      </p>
                    </div>
                  ) : templates.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-sm text-muted-foreground">
                        No resource templates available
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {templates.map((template) => (
                        <div
                          key={template.uriTemplate}
                          className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                            selectedTemplate === template.uriTemplate
                              ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                              : "hover:shadow-sm"
                          }`}
                          onClick={() => {
                            setTemplateOverrides({});
                            setSelectedTemplate(template.uriTemplate);
                            setResourceContent(null);
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <FileCode className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border truncate">
                                  {template.name}
                                </code>
                              </div>
                              <p className="text-xs mt-1 line-clamp-1 leading-relaxed text-muted-foreground font-mono">
                                {template.uriTemplate}
                              </p>
                              {template.description && (
                                <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
                                  {template.description}
                                </p>
                              )}
                            </div>
                            <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );

  const centerContent = (
    <div className="h-full flex flex-col bg-background">
      {error ? (
        <div className="p-4">
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
            {error}
          </div>
        </div>
      ) : resourceContent ? (
        <div className="flex-1 min-h-0 p-4 flex flex-col">
          {resourceContent?.contents?.map((content: any, index: number) => (
            <div key={index} className="flex-1 min-h-0">
              {content.type === "text" ? (
                <pre className="h-full text-xs font-mono whitespace-pre-wrap p-4 bg-muted/30 border border-border rounded-md overflow-auto">
                  {content.text}
                </pre>
              ) : (
                <div className="h-full">
                  <JsonEditor
                    value={content}
                    readOnly
                    showToolbar={false}
                    height="100%"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
              <Eye className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              {selectedResource || selectedTemplate
                ? "Response"
                : "No selection"}
            </p>
            <p className="text-xs text-muted-foreground font-medium">
              {selectedResource
                ? "Loading..."
                : selectedTemplate
                  ? "Fill in parameters and click Read"
                  : "Select an item from the sidebar"}
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <ThreePanelLayout
      id="resources"
      sidebar={sidebarContent}
      content={centerContent}
      sidebarVisible={isSidebarVisible}
      onSidebarVisibilityChange={setIsSidebarVisible}
      sidebarTooltip="Show resources sidebar"
      serverName={serverName}
    />
  );
}
