import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { BookOpen, Play, Wrench } from "lucide-react";
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
import { JsonEditor } from "@/components/ui/json-editor";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { MCPAppsRenderer } from "@/components/chat-v2/thread/mcp-apps/mcp-apps-renderer";
import { extractDisplayFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { useLearningServer } from "@/hooks/use-learning-server";
import {
  buildParametersFromFields,
  applyParametersToFields,
  generateFormFieldsFromSchema,
  type FormField,
} from "@/lib/tool-form";
import {
  executeToolApi,
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { detectUIType, getUIResourceUri } from "@/lib/mcp-ui/mcp-apps-utils";
import { cn } from "@/lib/utils";
import { LearningSandboxServerInfoPanel } from "./LearningSandboxServerInfoPanel";
import { LearningSandboxShell } from "./LearningSandboxShell";
import {
  learningExampleManifest,
  type LearningToolExample,
} from "./learning-example-manifest";

interface LearningToolsExplorerProps {
  autoConnect?: boolean;
  serverId?: string;
  serverUrl?: string;
}

function findToolExample(toolName: string | null): LearningToolExample | null {
  if (!toolName) {
    return null;
  }

  return (
    learningExampleManifest.tools.find(
      (example) => example.targetName === toolName,
    ) ?? null
  );
}

function normalizeToolMap(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

export function LearningToolsExplorer({
  autoConnect = true,
  serverId,
  serverUrl,
}: LearningToolsExplorerProps) {
  const learningServer = useLearningServer({
    autoConnect,
    serverId,
    serverUrl,
  });
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);
  const [selectedToolName, setSelectedToolName] = useState<string>("");
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    learningExampleManifest.tools[0]?.id ?? null,
  );
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [rawParameters, setRawParameters] = useState("{}");
  const [loadingTools, setLoadingTools] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"guided" | "raw">("guided");
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [auxiliaryResult, setAuxiliaryResult] = useState<unknown>(null);
  const [toolRunVersion, setToolRunVersion] = useState(0);

  const toolMap = useMemo(
    () => normalizeToolMap(toolsData?.tools ?? []),
    [toolsData?.tools],
  );
  const selectedTool = selectedToolName ? toolMap[selectedToolName] : undefined;
  const selectedExample = useMemo(
    () =>
      learningExampleManifest.tools.find(
        (example) => example.id === selectedExampleId,
      ) ?? findToolExample(selectedToolName),
    [selectedExampleId, selectedToolName],
  );
  const selectedToolMetadata = useMemo(() => {
    if (!selectedToolName) {
      return undefined;
    }

    return (
      toolsData?.toolsMetadata?.[selectedToolName] ??
      (selectedTool?._meta as Record<string, unknown> | undefined)
    );
  }, [selectedTool?._meta, selectedToolName, toolsData?.toolsMetadata]);
  const uiType = useMemo(
    () => detectUIType(selectedToolMetadata, result),
    [result, selectedToolMetadata],
  );
  const uiResourceUri = useMemo(
    () => getUIResourceUri(uiType, selectedToolMetadata),
    [selectedToolMetadata, uiType],
  );
  const displayValue = useMemo(() => {
    if (result) {
      const display = extractDisplayFromToolResult(result);
      if (display?.kind === "json") {
        return display.value;
      }
      if (display?.kind === "text") {
        return display.text;
      }
      return result;
    }

    return auxiliaryResult;
  }, [auxiliaryResult, result]);

  useEffect(() => {
    if (!learningServer.isConnected) {
      return;
    }

    let cancelled = false;
    const fetchTools = async () => {
      setLoadingTools(true);
      setError("");

      try {
        const response = await listTools({ serverId: learningServer.serverId });
        if (cancelled) {
          return;
        }

        setToolsData(response);
        const availableToolNames = response.tools.map((tool) => tool.name);
        if (availableToolNames.length === 0) {
          setSelectedToolName("");
          return;
        }

        const preferredTool =
          learningExampleManifest.tools.find((example) =>
            availableToolNames.includes(example.targetName),
          )?.targetName ?? availableToolNames[0];
        setSelectedToolName((current) =>
          current && availableToolNames.includes(current)
            ? current
            : preferredTool,
        );
      } catch (fetchError) {
        if (!cancelled) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to fetch tools.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingTools(false);
        }
      }
    };

    void fetchTools();

    return () => {
      cancelled = true;
    };
  }, [learningServer.isConnected, learningServer.serverId]);

  useEffect(() => {
    if (!selectedTool) {
      setFormFields([]);
      setRawParameters("{}");
      return;
    }

    const example =
      selectedExample?.targetName === selectedTool.name
        ? selectedExample
        : findToolExample(selectedTool.name);
    const baseFields = generateFormFieldsFromSchema(selectedTool.inputSchema);
    setFormFields(
      example?.defaultParameters
        ? applyParametersToFields(baseFields, example.defaultParameters)
        : baseFields,
    );
    setRawParameters(
      example?.rawParameters ??
        JSON.stringify(example?.defaultParameters ?? {}, null, 2),
    );
  }, [selectedExample, selectedTool]);

  const handleFieldChange = useCallback((name: string, value: unknown) => {
    setFormFields((current) =>
      current.map((field) =>
        field.name === name ? { ...field, value, isSet: true } : field,
      ),
    );
  }, []);

  const handleToggleField = useCallback((name: string, isSet: boolean) => {
    setFormFields((current) =>
      current.map((field) =>
        field.name === name ? { ...field, isSet } : field,
      ),
    );
  }, []);

  const executeSelectedTool = useCallback(async () => {
    if (!selectedToolName) {
      return;
    }

    setExecuting(true);
    setError("");
    setAuxiliaryResult(null);
    setResult(null);

    try {
      const parameters =
        mode === "raw"
          ? JSON.parse(rawParameters || "{}")
          : buildParametersFromFields(formFields);
      const response = await executeToolApi(
        learningServer.serverId,
        selectedToolName,
        parameters,
      );

      if ("error" in response) {
        setError(response.error);
        return;
      }

      if (response.status === "completed") {
        setResult(response.result);
      } else if (response.status === "task_created") {
        setAuxiliaryResult({
          status: response.status,
          task: response.task,
          modelImmediateResponse: response.modelImmediateResponse ?? null,
        });
      } else {
        setAuxiliaryResult({
          status: response.status,
          executionId: response.executionId,
          requestId: response.requestId,
          request: response.request,
        });
      }

      setToolRunVersion((current) => current + 1);
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Tool execution failed.",
      );
    } finally {
      setExecuting(false);
    }
  }, [
    formFields,
    learningServer.serverId,
    mode,
    rawParameters,
    selectedToolName,
  ]);

  const handlePresetSelect = useCallback((example: LearningToolExample) => {
    setSelectedExampleId(example.id);
    setSelectedToolName(example.targetName);
  }, []);

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
            {learningExampleManifest.tools.map((example) => {
              const active = example.id === selectedExampleId;
              return (
                <button
                  key={example.id}
                  type="button"
                  onClick={() => handlePresetSelect(example)}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{example.title}</span>
                    <Badge variant="outline">{example.targetName}</Badge>
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
            {Object.values(toolMap).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {loadingTools
                  ? "Loading tools from the sandbox server..."
                  : "No tools discovered yet."}
              </p>
            ) : (
              Object.values(toolMap).map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => {
                    setSelectedExampleId(null);
                    setSelectedToolName(tool.name);
                  }}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    selectedToolName === tool.name
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{tool.name}</span>
                    <Wrench className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tool.description ||
                      "No description provided by the server."}
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

  if (!learningServer.isConnected && learningServer.isConnecting) {
    return (
      <LearningSandboxShell
        id="learning-tools"
        title="Learning sandbox: tools"
        description="Experiment with live tool calls against the hidden learning server."
        serverId={learningServer.serverId}
        sidebar={sidebar}
        serverInfo={serverInfo}
      >
        <EmptyState
          icon={BookOpen}
          title="Connecting to the learning server"
          description="The sandbox is creating its hidden runtime-only connection."
          className="h-full"
        />
      </LearningSandboxShell>
    );
  }

  return (
    <LearningSandboxShell
      id="learning-tools"
      title="Learning sandbox: tools"
      description="Use guided presets or raw JSON params while the shared logger shows every RPC message for the sandbox connection."
      serverId={learningServer.serverId}
      sidebar={sidebar}
      serverInfo={serverInfo}
    >
      {!learningServer.isConnected ? (
        <EmptyState
          icon={BookOpen}
          title="Sandbox unavailable"
          description={
            learningServer.error ??
            "The learning server is not connected. Reconnect to continue."
          }
          className="h-full"
        />
      ) : !selectedTool ? (
        <EmptyState
          icon={Wrench}
          title="No tool selected"
          description="Pick one of the guided examples or a discovered tool to begin."
          className="h-full"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card className="gap-4 py-4">
            <CardHeader className="px-4 pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-sm">{selectedTool.name}</CardTitle>
                  <CardDescription className="text-xs">
                    {selectedTool.description || "No description provided."}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => void executeSelectedTool()}
                  disabled={executing || loadingTools}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {executing ? "Running..." : "Run tool"}
                </Button>
              </div>
              {selectedExample ? (
                <p className="text-xs text-muted-foreground">
                  {selectedExample.objective}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              <Tabs
                value={mode}
                onValueChange={(value) => setMode(value as "guided" | "raw")}
              >
                <TabsList>
                  <TabsTrigger value="guided">Guided form</TabsTrigger>
                  <TabsTrigger value="raw">Raw JSON</TabsTrigger>
                </TabsList>
                <TabsContent value="guided">
                  <div className="rounded-lg border border-border/60">
                    <ParametersForm
                      fields={formFields}
                      onFieldChange={handleFieldChange}
                      onToggleField={handleToggleField}
                      onExecute={() => void executeSelectedTool()}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="raw" className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Edit the raw tool arguments directly to see how server
                    errors and validation behave.
                  </p>
                  <div className="h-64 overflow-hidden rounded-lg border border-border/60">
                    <JsonEditor
                      rawContent={rawParameters}
                      onRawChange={setRawParameters}
                      mode="edit"
                      showModeToggle={false}
                      height="100%"
                    />
                  </div>
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
              <CardTitle className="text-sm">Result and UI</CardTitle>
              <CardDescription className="text-xs">
                Successful tool calls appear here. When a tool advertises a UI
                resource, the shared MCP Apps renderer is mounted inline.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              {uiResourceUri && result ? (
                <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20">
                  <MCPAppsRenderer
                    serverId={learningServer.serverId}
                    toolCallId={`${selectedTool.name}-${toolRunVersion}`}
                    toolName={selectedTool.name}
                    toolInput={
                      mode === "raw"
                        ? (() => {
                            try {
                              return JSON.parse(
                                rawParameters || "{}",
                              ) as Record<string, unknown>;
                            } catch {
                              return {};
                            }
                          })()
                        : buildParametersFromFields(formFields)
                    }
                    toolOutput={result}
                    resourceUri={uiResourceUri}
                    toolMetadata={selectedToolMetadata}
                    toolsMetadata={toolsData?.toolsMetadata}
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
