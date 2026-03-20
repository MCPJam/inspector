import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { FileCode, Play, RefreshCw, ChevronRight, Eye } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  MCPServerConfig,
  type MCPResourceTemplate,
  type MCPReadResourceResult,
} from "@mcpjam/sdk";
import { listResourceTemplates as listResourceTemplatesApi } from "@/lib/apis/mcp-resource-templates-api";
import { readResource as readResourceTemplateApi } from "@/lib/apis/mcp-resources-api";
import { LoggerView } from "./logger-view";
import { parseTemplate } from "url-template";

interface ResourceTemplatesTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  onRegisterRefresh?: (refresh: () => void) => void;
}

// RFC 6570 compliant URI template parameter extraction
function extractTemplateParameters(uriTemplate: string): string[] {
  const params = new Set<string>();

  // Parse all RFC 6570 expressions: {var}, {+var}, {#var}, {?var}, {&var}, etc.
  const paramRegex = /\{[+#./;?&]?([^}]+)\}/g;
  let match;

  while ((match = paramRegex.exec(uriTemplate)) !== null) {
    // Split on comma to handle multi-variable expressions like {?x,y,z}
    const variables = match[1].replace(/^[+#./;?&]/, "").split(",");

    variables.forEach((v) => {
      // Handle variable modifiers like :3 (prefix) or * (explode)
      const varName = v.split(":")[0].replace(/\*$/, "").trim();
      if (varName) params.add(varName);
    });
  }

  return Array.from(params);
}

// RFC 6570 compliant URI template expansion using url-template library
function buildUriFromTemplate(
  uriTemplate: string,
  params: Record<string, string>,
): string {
  const template = parseTemplate(uriTemplate);

  // RFC 6570 compliant expansion:
  // - Undefined values expand to empty string (removes the expression)
  // - Query params {?x,y} expand to ?x=val1&y=val2 or empty if both undefined
  // - Fragment {#x} expands to #val or empty if undefined
  // - Reserved {+x} expands with reserved characters
  return template.expand(params);
}

export function ResourceTemplatesTab({
  serverConfig,
  serverName,
  onRegisterRefresh,
}: ResourceTemplatesTabProps) {
  const [templates, setTemplates] = useState<MCPResourceTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [resourceContent, setResourceContent] =
    useState<MCPReadResourceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingTemplates, setFetchingTemplates] = useState(false);
  const [error, setError] = useState<string>("");

  const selectedTemplateData = useMemo(() => {
    return (
      templates.find((template) => template.uriTemplate === selectedTemplate) ??
      null
    );
  }, [templates, selectedTemplate]);

  const [templateOverrides, setTemplateOverrides] = useState<
    Record<string, string>
  >({});

  const templateParams = useMemo(() => {
    if (selectedTemplateData?.uriTemplate) {
      const paramNames = extractTemplateParameters(
        selectedTemplateData.uriTemplate,
      );
      return paramNames.map((name) => ({
        name,
        value: templateOverrides[name] ?? "",
      }));
    } else {
      return [];
    }
  }, [selectedTemplateData?.uriTemplate, templateOverrides]);

  useEffect(() => {
    if (serverConfig && serverName) {
      fetchTemplates();
    }
  }, [serverConfig, serverName]);

  // Register refresh function for parent component
  useEffect(() => {
    onRegisterRefresh?.(fetchTemplates);
  }, [onRegisterRefresh, fetchTemplates]);

  const fetchTemplates = async () => {
    if (!serverName) return;

    setFetchingTemplates(true);
    setTemplateOverrides({});
    setError("");
    setTemplates([]);
    setSelectedTemplate("");
    setResourceContent(null);

    try {
      const serverTemplates = await listResourceTemplatesApi(serverName);
      setTemplates(serverTemplates);

      if (serverTemplates.length === 0) {
        setSelectedTemplate("");
        setTemplateOverrides({});
        setResourceContent(null);
      } else if (
        !serverTemplates.some(
          (template) => template.uriTemplate === selectedTemplate,
        )
      ) {
        setResourceContent(null);
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Could not fetch resource templates: ${err}`;
      setError(message);
    } finally {
      setFetchingTemplates(false);
    }
  };

  const updateParamValue = (paramName: string, value: string) => {
    setTemplateOverrides((prev) => ({ ...prev, [paramName]: value }));
  };

  const buildParameters = (): Record<string, string> => {
    const params: Record<string, string> = {};
    templateParams.forEach((param) => {
      if (param.value !== "") {
        params[param.name] = param.value;
      }
    });
    return params;
  };

  const getResolvedUri = (): string => {
    if (!selectedTemplateData) return "";
    const params = buildParameters();
    return buildUriFromTemplate(selectedTemplateData.uriTemplate, params);
  };

  const readResource = async () => {
    if (!selectedTemplate || !serverName) return;

    setLoading(true);
    setError("");

    try {
      const uri = getResolvedUri();
      const data = await readResourceTemplateApi(serverName, uri);
      setResourceContent(data?.content ?? null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Error reading resource: ${err}`;
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // Handle Enter key in input fields
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      readResource();
    }
  };

  // Handle Enter key to read resource globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && selectedTemplate && !loading) {
        // Don't trigger if user is typing in an input, textarea, or contenteditable
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        readResource();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTemplate, loading, templateParams]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={FileCode}
        title="No Server Selected"
        description="Connect to an MCP server to browse and explore its available resource templates."
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Templates and Parameters */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Templates List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Templates List */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2">
                      {fetchingTemplates ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                            <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                          </div>
                          <p className="text-xs text-muted-foreground font-semibold mb-1">
                            Loading templates...
                          </p>
                          <p className="text-xs text-muted-foreground/70">
                            Fetching available resource templates from server
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
                          {templates.map((template) => {
                            const isSelected =
                              selectedTemplate === template.uriTemplate;
                            const displayName = template.name;
                            return (
                              <div
                                key={template.uriTemplate}
                                className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                                  isSelected
                                    ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                                    : "hover:shadow-sm"
                                }`}
                                onClick={() => {
                                  setTemplateOverrides({});
                                  setSelectedTemplate(template.uriTemplate);
                                }}
                              >
                                <div className="flex items-start gap-3">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                        {displayName}
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
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Panel - Parameters */}
            <ResizablePanel defaultSize={70} minSize={50}>
              <div className="h-full flex flex-col bg-background">
                {selectedTemplate ? (
                  <>
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                            {selectedTemplateData?.name || selectedTemplate}
                          </code>
                          {selectedTemplateData?.mimeType && (
                            <Badge
                              variant="outline"
                              className="text-xs font-mono"
                            >
                              {selectedTemplateData.mimeType}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono truncate max-w-md">
                          {getResolvedUri() || selectedTemplate}
                        </p>
                      </div>
                      <Button
                        onClick={readResource}
                        disabled={loading || !selectedTemplate}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
                        size="sm"
                      >
                        {loading ? (
                          <>
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            Loading
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
                    {selectedTemplateData?.description && (
                      <div className="px-6 py-4 bg-muted/50 border-b border-border">
                        <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                          {selectedTemplateData.description}
                        </p>
                      </div>
                    )}

                    {/* Parameters */}
                    <div className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full">
                        <div className="px-6 py-6">
                          {templateParams.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <Play className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                No parameters required
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                This template can be used directly
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-8">
                              {/* Parameter Fields */}
                              {templateParams.map((param) => (
                                <div key={param.name} className="group">
                                  <div className="flex items-start justify-between mb-3">
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-3">
                                        <code className="font-mono text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                          {param.name}
                                        </code>
                                        <div
                                          className="w-1.5 h-1.5 bg-amber-400 dark:bg-amber-500 rounded-full"
                                          title="Required parameter"
                                        />
                                      </div>
                                    </div>
                                    <Badge
                                      variant="secondary"
                                      className="text-xs font-mono font-medium"
                                    >
                                      string
                                    </Badge>
                                  </div>

                                  <div className="space-y-2">
                                    <Input
                                      type="text"
                                      value={param.value}
                                      onChange={(e) =>
                                        updateParamValue(
                                          param.name,
                                          e.target.value,
                                        )
                                      }
                                      onKeyDown={handleInputKeyDown}
                                      placeholder={`Enter ${param.name}`}
                                      className="bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs"
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                        <FileCode className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground mb-1">
                        Select a template
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Choose a resource template from the left to view details
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - JSON-RPC Logger and Results */}
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
                                            height="100%"
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
