import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import {
  FolderOpen,
  File,
  RefreshCw,
  ChevronRight,
  Eye,
  PanelLeftClose,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  MCPServerConfig,
  type MCPReadResourceResult,
  type MCPResource,
} from "@mcpjam/sdk";
import {
  listResources,
  readResource as readResourceApi,
} from "@/lib/apis/mcp-resources-api";
import { SelectedToolHeader } from "./ui-playground/SelectedToolHeader";
import { ResourceTemplatesTab } from "./ResourceTemplatesTab";

interface ResourcesTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
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

  // Panel state
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Derived data
  const selectedResourceData = useMemo(() => {
    return (
      resources.find((resource) => resource.uri === selectedResource) ?? null
    );
  }, [resources, selectedResource]);

  // Fetch resources on mount
  useEffect(() => {
    if (serverConfig && serverName) {
      fetchResources();
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

  // Handle Enter key to read resource globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !loading &&
        activeTab === "resources" &&
        selectedResource
      ) {
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        readResource(selectedResource);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedResource, loading, activeTab]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No Server Selected"
        description="Connect to an MCP server to browse and explore its available resources."
      />
    );
  }

  const tabs = [
    { id: "resources" as const, label: "Resources" },
    { id: "templates" as const, label: "Resource Templates" },
  ];

  const tabClassName = (isActive: boolean) =>
    `px-4 py-3 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
      isActive
        ? "border-primary text-primary"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`;

  const sidebarContent = (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* App Builder-style Header */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Title */}
          <div className="flex items-center gap-1.5">
            <span className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary">
              Resources
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {resources.length}
              </span>
            </span>
          </div>

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={() => fetchResources()}
              variant="ghost"
              size="sm"
              disabled={fetchingResources}
              className="h-7 w-7 p-0"
              title="Refresh resources"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${fetchingResources ? "animate-spin" : ""}`}
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

      {/* Content area - show detail view when resource is selected */}
      {selectedResource && selectedResourceData ? (
        <div className="flex-1 flex flex-col min-h-0">
          <SelectedToolHeader
            toolName={selectedResourceData.name || selectedResource}
            description={selectedResourceData.description}
            onExpand={() => setSelectedResource("")}
            onClear={() => setSelectedResource("")}
          />
        </div>
      ) : (
        /* Resources List */
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2 pb-16">
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
              {selectedResource ? "Response" : "No selection"}
            </p>
            <p className="text-xs text-muted-foreground font-medium">
              {selectedResource
                ? "Loading..."
                : "Select a resource from the sidebar"}
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="border-b border-border flex-shrink-0">
        <div className="flex">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={tabClassName(activeTab === tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "templates" ? (
        <ResourceTemplatesTab
          serverConfig={serverConfig}
          serverName={serverName}
        />
      ) : (
        <ThreePanelLayout
          id="resources"
          sidebar={sidebarContent}
          content={centerContent}
          sidebarVisible={isSidebarVisible}
          onSidebarVisibilityChange={setIsSidebarVisible}
          sidebarTooltip="Show resources sidebar"
          serverName={serverName}
        />
      )}
    </div>
  );
}
