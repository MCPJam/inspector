import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { FolderOpen, File, RefreshCw, ChevronRight, Eye } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  MCPServerConfig,
  type MCPReadResourceResult,
  type MCPResource,
} from "@mcpjam/sdk";
import { LoggerView } from "./logger-view";
import { listResources } from "@/lib/apis/mcp-resources-api";
import { authFetch } from "@/lib/session-token";

interface ResourcesTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

export function ResourcesTab({ serverConfig, serverName }: ResourcesTabProps) {
  const [resources, setResources] = useState<MCPResource[]>([]);
  const [selectedResource, setSelectedResource] = useState<string>("");
  const [resourceContent, setResourceContent] =
    useState<MCPReadResourceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingResources, setFetchingResources] = useState(false);
  const [error, setError] = useState<string>("");
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (serverConfig && serverName) {
      fetchResources();
    }
  }, [serverConfig, serverName]);

  const selectedResourceData = useMemo(() => {
    return (
      resources.find((resource) => resource.uri === selectedResource) ?? null
    );
  }, [resources, selectedResource]);

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

  const readResource = async (uri: string) => {
    if (!serverName) return;
    setLoading(true);
    setError("");

    try {
      const response = await authFetch("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: serverName,
          uri: uri,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setResourceContent(data.content ?? null);
      } else {
        setError(data.error || "Failed to read resource");
      }
    } catch (err) {
      setError(`Network error reading resource: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  // Handle Enter key to read resource globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && selectedResource && !loading) {
        // Don't trigger if user is typing in an input, textarea, or contenteditable
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
  }, [selectedResource, loading]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No Server Selected"
        description="Connect to an MCP server to browse and explore its available resources."
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Resources and Preview */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Resources List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="h-3 w-3 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-foreground">
                      Resources
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {resources.length}
                    </Badge>
                  </div>
                  <Button
                    onClick={() => fetchResources()}
                    variant="ghost"
                    size="sm"
                    disabled={fetchingResources}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${fetchingResources ? "animate-spin" : ""} cursor-pointer`}
                    />
                  </Button>
                </div>

                {/* Resources List */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2">
                      {fetchingResources ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                            <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                          </div>
                          <p className="text-xs text-muted-foreground font-semibold mb-1">
                            Loading resources...
                          </p>
                          <p className="text-xs text-muted-foreground/70">
                            Fetching available resources from server
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
                                onClick={() =>
                                  setSelectedResource(resource.uri)
                                }
                              >
                                <div className="flex items-start gap-3">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <File className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                      <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
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

                          {/* Sentinel observed by IntersectionObserver */}
                          <div ref={sentinelRef} className="h-4" />

                          {loadingMore && (
                            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground gap-2">
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              <span>Loading more resources…</span>
                            </div>
                          )}

                          {!nextCursor &&
                            resources.length > 0 &&
                            !loadingMore && (
                              <div className="text-center py-3 text-xs text-muted-foreground">
                                No more resources
                              </div>
                            )}
                        </>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Panel - Resource Preview */}
            <ResizablePanel defaultSize={70} minSize={50}>
              <div className="h-full flex flex-col bg-background">
                {selectedResource ? (
                  <>
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                      <div className="space-y-2">
                        <div className="flex items-center gap-1">
                          <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                            {selectedResourceData?.name || selectedResource}
                          </code>
                          &bull;
                          <p className="text-xs text-muted-foreground font-mono truncate max-w-md">
                            {selectedResource}
                          </p>
                        </div>

                        {selectedResourceData?.mimeType && (
                          <Badge
                            variant="outline"
                            className="text-xs font-mono"
                          >
                            {selectedResourceData.mimeType}
                          </Badge>
                        )}
                      </div>
                      <Button
                        onClick={() => readResource(selectedResource)}
                        disabled={loading}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
                        size="sm"
                      >
                        {loading ? (
                          <>
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            Reading
                          </>
                        ) : (
                          <>
                            <Eye className="h-3 w-3" />
                            Read
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Description */}
                    {selectedResourceData?.description && (
                      <div className="px-6 py-4 bg-muted/50 border-b border-border">
                        <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                          {selectedResourceData.description}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                        <FolderOpen className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground mb-1">
                        Select a resource
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Choose a resource from the left to preview its content
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - JSON-RPC Logger and Status */}
        <ResizablePanel defaultSize={30} minSize={15} maxSize={70}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={40} minSize={10}>
              <LoggerView serverIds={serverName ? [serverName] : undefined} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={30}>
              <div className="h-full flex flex-col border-t border-border bg-background break-all">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h2 className="text-xs font-semibold text-foreground">
                    Response
                  </h2>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                  {error ? (
                    <div className="p-4">
                      <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                        {error}
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full">
                        <div className="p-4">
                          {!resourceContent ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <Eye className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                Ready to read resource
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                Click the Read button to view resource content
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-4">
                              {resourceContent?.contents?.map(
                                (content: any, index: number) => (
                                  <div key={index} className="group">
                                    <div className="overflow-hidden">
                                      {content.type === "text" ? (
                                        <pre className="text-xs font-mono whitespace-pre-wrap p-4 bg-background overflow-auto max-h-96">
                                          {content.text}
                                        </pre>
                                      ) : (
                                        <div className="p-4">
                                          <JsonEditor
                                            value={content}
                                            readOnly
                                            showToolbar={false}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
