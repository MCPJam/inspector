import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  FolderOpen,
  File,
  FileCode,
  RefreshCw,
  Eye,
  PanelLeftClose,
  Play,
  X,
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
import { listResourceTemplates } from "@/lib/apis/mcp-resource-templates-api";
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
  const [templateContent, setTemplateContent] =
    useState<MCPReadResourceResult | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [fetchingTemplates, setFetchingTemplates] = useState(false);
  const [templateError, setTemplateError] = useState<string>("");
  const [templateOverrides, setTemplateOverrides] = useState<
    Record<string, string>
  >({});

  // Panel state
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const selectedTemplateData = useMemo(() => {
    return templates.find((t) => t.uriTemplate === selectedTemplate) ?? null;
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

  // Fetch resources and templates on mount
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
    setTemplateError("");
    setTemplates([]);
    setSelectedTemplate("");
    setTemplateOverrides({});
    setTemplateContent(null);

    try {
      const serverTemplates = await listResourceTemplates(serverName);
      setTemplates(serverTemplates);
    } catch (err) {
      setTemplateError(`Could not fetch resource templates: ${err}`);
    } finally {
      setFetchingTemplates(false);
    }
  };

  const loadMoreResources = useCallback(async () => {
    if (loadingMore) return;
    if (!nextCursor) return;

    await fetchResources(nextCursor, true);
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

  // Template parameter helpers
  const updateParamValue = (paramName: string, value: string) => {
    setTemplateOverrides((prev) => ({ ...prev, [paramName]: value }));
  };

  const buildParameters = useCallback((): Record<string, string> => {
    const params: Record<string, string> = {};
    templateParams.forEach((param) => {
      if (param.value !== "") {
        params[param.name] = param.value;
      }
    });
    return params;
  }, [templateParams]);

  const getResolvedUri = useCallback((): string => {
    if (!selectedTemplateData) return "";
    const params = buildParameters();
    return buildUriFromTemplate(selectedTemplateData.uriTemplate, params);
  }, [selectedTemplateData, buildParameters]);

  // Read template resource
  const readTemplateResource = useCallback(async () => {
    if (!selectedTemplate || !serverName) return;

    setTemplateLoading(true);
    setTemplateError("");

    try {
      const uri = getResolvedUri();
      const data = await readResourceApi(serverName, uri);
      setTemplateContent(data?.content ?? null);
    } catch (err) {
      setTemplateError(`Error reading resource: ${err}`);
    } finally {
      setTemplateLoading(false);
    }
  }, [selectedTemplate, serverName, getResolvedUri]);

  // Handle Enter key in template input fields
  const handleTemplateInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Enter" && !templateLoading) {
      e.preventDefault();
      readTemplateResource();
    }
  };

  // Handle Enter key to read resource globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey) return;

      const target = e.target as HTMLElement;
      const tagName = target.tagName;
      const isEditable = target.isContentEditable;

      if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
        return;
      }

      if (activeTab === "resources" && selectedResource && !loading) {
        e.preventDefault();
        readResource(selectedResource);
      } else if (
        activeTab === "templates" &&
        selectedTemplate &&
        !templateLoading
      ) {
        e.preventDefault();
        readTemplateResource();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedResource,
    loading,
    activeTab,
    selectedTemplate,
    templateLoading,
    readTemplateResource,
  ]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No Server Selected"
        description="Connect to an MCP server to browse and explore its available resources."
      />
    );
  }

  const isFetching =
    activeTab === "resources" ? fetchingResources : fetchingTemplates;

  const sidebarContent = (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* Header with tabs and actions */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Tabs */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveTab("resources")}
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
              onClick={() => setActiveTab("templates")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "templates"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Templates
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {templates.length}
              </span>
            </button>
          </div>

          {/* Action buttons */}
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              onClick={() => {
                if (activeTab === "resources") {
                  fetchResources();
                } else {
                  fetchTemplates();
                }
              }}
              variant="ghost"
              size="sm"
              disabled={isFetching}
              className="h-7 w-7 p-0"
              title={
                activeTab === "resources"
                  ? "Refresh resources"
                  : "Refresh templates"
              }
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
        </div>
      </div>

      {/* Content - Resources list, Templates list, or Template parameters */}
      {activeTab === "templates" && selectedTemplate ? (
        /* Template Parameters Form (in sidebar) */
        <div className="flex-1 flex flex-col min-h-0">
          {/* Template header */}
          <div className="bg-muted/30 flex-shrink-0 px-3 py-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <button
                  onClick={() => setSelectedTemplate("")}
                  className="hover:bg-muted/50 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-left"
                  title="Click to go back to list"
                >
                  <code className="text-xs font-mono font-medium text-foreground truncate block">
                    {selectedTemplateData?.name || selectedTemplate}
                  </code>
                </button>
                {selectedTemplateData?.description && (
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {selectedTemplateData.description}
                  </p>
                )}
                {/* URI preview */}
                <p className="text-xs text-muted-foreground font-mono truncate mt-2">
                  {getResolvedUri() || selectedTemplate}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground flex-shrink-0"
                onClick={() => {
                  setSelectedTemplate("");
                  setTemplateOverrides({});
                  setTemplateContent(null);
                }}
                title="Clear selection"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* Parameters */}
          <ScrollArea className="flex-1">
            <div className="px-3 py-3">
              {templateParams.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  No parameters required
                </p>
              ) : (
                <div className="space-y-3">
                  {templateParams.map((param) => (
                    <div key={param.name} className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs font-medium text-foreground">
                          {param.name}
                        </code>
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400"
                        >
                          required
                        </Badge>
                      </div>
                      <Input
                        type="text"
                        value={param.value}
                        onChange={(e) =>
                          updateParamValue(param.name, e.target.value)
                        }
                        onKeyDown={handleTemplateInputKeyDown}
                        placeholder={`Enter ${param.name}`}
                        className="bg-background border-border text-xs h-8"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Read button */}
          <div className="p-3 border-t border-border">
            <Button
              onClick={readTemplateResource}
              disabled={templateLoading || !selectedTemplate}
              className="w-full"
              size="sm"
            >
              {templateLoading ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin mr-2" />
                  Loading
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-2" />
                  Read Resource
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        /* Resources or Templates List */
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2 pb-16">
              {activeTab === "resources" ? (
                /* Resources List */
                fetchingResources ? (
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
                          className={`cursor-pointer transition-shadow duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                            selectedResource === resource.uri
                              ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                              : "hover:shadow-sm"
                          }`}
                          onClick={() => {
                            setSelectedResource(resource.uri);
                            readResource(resource.uri);
                          }}
                        >
                          <div className="flex items-center gap-2">
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
                )
              ) : /* Templates List */
              fetchingTemplates ? (
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
                      className={`cursor-pointer transition-shadow duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                        selectedTemplate === template.uriTemplate
                          ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                          : "hover:shadow-sm"
                      }`}
                      onClick={() => {
                        setTemplateOverrides({});
                        setSelectedTemplate(template.uriTemplate);
                        setTemplateContent(null);
                      }}
                    >
                      <div className="flex items-center gap-2">
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
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );

  const resourcesCenterContent = (
    <div className="h-full flex flex-col bg-background">
      {error ? (
        <div className="p-4">
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
            {error}
          </div>
        </div>
      ) : loading ? (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
              <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              Loading resource...
            </p>
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
              No selection
            </p>
            <p className="text-xs text-muted-foreground font-medium">
              Select a resource from the sidebar
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const templatesCenterContent = (
    <div className="h-full flex flex-col bg-background">
      {templateError ? (
        <div className="p-4">
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
            {templateError}
          </div>
        </div>
      ) : templateLoading ? (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
              <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              Loading resource...
            </p>
          </div>
        </div>
      ) : templateContent ? (
        <div className="flex-1 min-h-0 p-4 flex flex-col">
          {templateContent?.contents?.map((content: any, index: number) => (
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
              {selectedTemplate ? "Ready to read" : "Select a template"}
            </p>
            <p className="text-xs text-muted-foreground font-medium">
              {selectedTemplate
                ? "Click Read Resource to view content"
                : "Choose a resource template from the sidebar"}
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
      content={
        activeTab === "templates"
          ? templatesCenterContent
          : resourcesCenterContent
      }
      sidebarVisible={isSidebarVisible}
      onSidebarVisibilityChange={setIsSidebarVisible}
      sidebarTooltip="Show resources sidebar"
      serverName={serverName}
    />
  );
}
