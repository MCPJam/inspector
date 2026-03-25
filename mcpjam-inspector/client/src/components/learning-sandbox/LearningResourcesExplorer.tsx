import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, FileText, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { JsonEditor } from "@/components/ui/json-editor";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MCPAppsRenderer } from "@/components/chat-v2/thread/mcp-apps/mcp-apps-renderer";
import { extractDisplayFromValue } from "@/components/chat-v2/shared/tool-result-text";
import { useLearningServer } from "@/hooks/use-learning-server";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { executeToolApi } from "@/lib/apis/mcp-tools-api";
import { cn } from "@/lib/utils";
import { LearningSandboxServerInfoPanel } from "./LearningSandboxServerInfoPanel";
import { LearningSandboxShell } from "./LearningSandboxShell";
import {
  learningExampleManifest,
} from "./learning-example-manifest";

interface LearningResourcesExplorerProps {
  autoConnect?: boolean;
  serverId?: string;
  serverUrl?: string;
}

type ResourceSummary = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export function LearningResourcesExplorer({
  autoConnect = true,
  serverId,
  serverUrl,
}: LearningResourcesExplorerProps) {
  const learningServer = useLearningServer({
    autoConnect,
    serverId,
    serverUrl,
  });
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [selectedUri, setSelectedUri] = useState<string>(
    learningExampleManifest.resources[0]?.uri ?? "",
  );
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    learningExampleManifest.resources[0]?.id ?? null,
  );
  const [rawUri, setRawUri] = useState(
    learningExampleManifest.resources[0]?.uri ?? "",
  );
  const [mode, setMode] = useState<"guided" | "raw">("guided");
  const [loadingResources, setLoadingResources] = useState(false);
  const [readingResource, setReadingResource] = useState(false);
  const [error, setError] = useState("");
  const [resourceContent, setResourceContent] = useState<unknown>(null);
  const [resourceViewVersion, setResourceViewVersion] = useState(0);

  const selectedExample = useMemo(
    () =>
      learningExampleManifest.resources.find(
        (example) => example.id === selectedExampleId,
      ) ?? null,
    [selectedExampleId],
  );
  const currentUri = mode === "raw" ? rawUri : selectedUri;
  const isUiResource = currentUri.startsWith("ui://");
  const displayValue = useMemo(() => {
    const content =
      resourceContent &&
      typeof resourceContent === "object" &&
      "content" in (resourceContent as Record<string, unknown>)
        ? (resourceContent as { content?: unknown }).content
        : resourceContent;
    const display = extractDisplayFromValue(content);

    if (display?.kind === "json") {
      return display.value;
    }
    if (display?.kind === "text") {
      return display.text;
    }
    return resourceContent;
  }, [resourceContent]);

  useEffect(() => {
    if (!learningServer.isConnected) {
      return;
    }

    let cancelled = false;
    const fetchResources = async () => {
      setLoadingResources(true);
      setError("");

      try {
        const response = await listResources(learningServer.serverId);
        if (cancelled) {
          return;
        }

        setResources(response.resources);
        const availableUris = response.resources.map((resource) => resource.uri);
        const preferredUri =
          learningExampleManifest.resources.find((example) =>
            availableUris.includes(example.uri),
          )?.uri ?? availableUris[0] ?? "";
        setSelectedUri((current) =>
          current && availableUris.includes(current) ? current : preferredUri,
        );
        setRawUri((current) => current || preferredUri);
      } catch (fetchError) {
        if (!cancelled) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to fetch resources.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingResources(false);
        }
      }
    };

    void fetchResources();

    return () => {
      cancelled = true;
    };
  }, [learningServer.isConnected, learningServer.serverId]);

  const readSelectedResource = useCallback(async () => {
    if (!currentUri) {
      return;
    }

    setReadingResource(true);
    setError("");

    try {
      const response = await readResource(learningServer.serverId, currentUri);
      setResourceContent(response);
      setResourceViewVersion((current) => current + 1);
    } catch (readError) {
      setError(
        readError instanceof Error
          ? readError.message
          : "Failed to read resource.",
      );
    } finally {
      setReadingResource(false);
    }
  }, [currentUri, learningServer.serverId]);

  const handleWidgetToolCall = useCallback(
    async (toolName: string, parameters: Record<string, unknown>) => {
      const response = await executeToolApi(
        learningServer.serverId,
        toolName,
        parameters,
      );
      if ("error" in response) {
        throw new Error(response.error);
      }
      if (response.status !== "completed") {
        throw new Error(
          `Sandbox widget tool calls require a completed response, received ${response.status}.`,
        );
      }
      return response.result;
    },
    [learningServer.serverId],
  );

  const sidebar = (
    <div className="h-full border-r border-border bg-background">
      <ScrollArea className="h-full">
        <div className="space-y-4 p-4">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Guided examples
            </p>
            {learningExampleManifest.resources.map((example) => {
              const active = example.id === selectedExampleId;
              return (
                <button
                  key={example.id}
                  type="button"
                  onClick={() => {
                    setSelectedExampleId(example.id);
                    setSelectedUri(example.uri);
                    setRawUri(example.uri);
                    setMode("guided");
                  }}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{example.title}</span>
                    <Badge variant="outline">{example.uri}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {example.description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Live discovery
            </p>
            {resources.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {loadingResources
                  ? "Loading resources from the sandbox server..."
                  : "No resources discovered yet."}
              </p>
            ) : (
              resources.map((resource) => (
                <button
                  key={resource.uri}
                  type="button"
                  onClick={() => {
                    setSelectedExampleId(null);
                    setSelectedUri(resource.uri);
                    setRawUri(resource.uri);
                    setMode("guided");
                  }}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    selectedUri === resource.uri && mode === "guided"
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{resource.name}</span>
                    <FileText className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {resource.description || resource.uri}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );

  const serverInfo = (
    <LearningSandboxServerInfoPanel
      serverName={learningServer.serverId}
      serverEntry={learningServer.serverEntry}
      initInfo={learningServer.initInfo}
      onReconnect={learningServer.reconnect}
      onDisconnect={learningServer.disconnect}
    />
  );

  return (
    <LearningSandboxShell
      id="learning-resources"
      title="Learning sandbox: resources"
      description="Read normal resources, try arbitrary URIs, and render ui:// content against the same hidden sandbox connection."
      serverId={learningServer.serverId}
      sidebar={sidebar}
      serverInfo={serverInfo}
    >
      {!learningServer.isConnected ? (
        <EmptyState
          icon={BookOpen}
          title="Sandbox unavailable"
          description={
            learningServer.isConnecting
              ? "The learning server is still connecting."
              : learningServer.error ??
                "The learning server is not connected. Reconnect to continue."
          }
          className="h-full"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card className="gap-4 py-4">
            <CardHeader className="px-4 pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-sm">Read a resource</CardTitle>
                  <CardDescription className="text-xs">
                    {selectedExample?.objective ??
                      "Experiment with the resource URI directly and compare the payload with the logger output."}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => void readSelectedResource()}
                  disabled={readingResource || !currentUri}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {readingResource ? "Reading..." : "Read resource"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              <Tabs
                value={mode}
                onValueChange={(value) => setMode(value as "guided" | "raw")}
              >
                <TabsList>
                  <TabsTrigger value="guided">Guided browse</TabsTrigger>
                  <TabsTrigger value="raw">Raw URI</TabsTrigger>
                </TabsList>
                <TabsContent value="guided" className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Resource reads use the currently selected discovered URI.
                  </p>
                  <div className="rounded-lg border border-border/60 px-3 py-2">
                    <code className="text-xs">{selectedUri || "No resource selected"}</code>
                  </div>
                </TabsContent>
                <TabsContent value="raw" className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Enter any resource URI to see success and error responses.
                  </p>
                  <Input
                    value={rawUri}
                    onChange={(event) => setRawUri(event.target.value)}
                    placeholder="ui://mcp-demo/mcp-app.html"
                  />
                </TabsContent>
              </Tabs>
              {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-4 py-4">
            <CardHeader className="px-4 pb-0">
              <CardTitle className="text-sm">Resource output</CardTitle>
              <CardDescription className="text-xs">
                ui:// resources render inline. Other resources are shown as text
                or JSON.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              {isUiResource && currentUri ? (
                <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20">
                  <MCPAppsRenderer
                    serverId={learningServer.serverId}
                    toolCallId={`resource-${resourceViewVersion}`}
                    toolName="resource-preview"
                    toolInput={{ uri: currentUri }}
                    toolOutput={resourceContent}
                    resourceUri={currentUri}
                    onCallTool={handleWidgetToolCall}
                    minimalMode
                  />
                </div>
              ) : null}
              <div className="h-[24rem] overflow-hidden rounded-lg border border-border/60">
                <JsonEditor
                  value={displayValue ?? { status: "idle" }}
                  readOnly
                  showToolbar={false}
                  height="100%"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </LearningSandboxShell>
  );
}
