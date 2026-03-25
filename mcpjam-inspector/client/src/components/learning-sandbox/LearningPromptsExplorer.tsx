import { useCallback, useEffect, useMemo, useState } from "react";
import type { MCPPrompt } from "@mcpjam/sdk/browser";
import { BookOpen, MessageSquare, Play } from "lucide-react";
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
import { extractDisplayFromValue } from "@/components/chat-v2/shared/tool-result-text";
import { useLearningServer } from "@/hooks/use-learning-server";
import { getPrompt, listPrompts } from "@/lib/apis/mcp-prompts-api";
import { cn } from "@/lib/utils";
import { LearningSandboxServerInfoPanel } from "./LearningSandboxServerInfoPanel";
import { LearningSandboxShell } from "./LearningSandboxShell";
import {
  learningExampleManifest,
  type LearningPromptExample,
} from "./learning-example-manifest";

interface LearningPromptsExplorerProps {
  autoConnect?: boolean;
  serverId?: string;
  serverUrl?: string;
}

type PromptField = {
  name: string;
  description?: string;
  required: boolean;
  value: string;
};

function buildPromptFields(
  prompt: MCPPrompt | null,
  example?: LearningPromptExample | null,
) {
  const defaultArguments = example?.defaultArguments ?? {};
  return (prompt?.arguments ?? []).map((argument) => ({
    name: argument.name,
    description: argument.description,
    required: Boolean(argument.required),
    value: defaultArguments[argument.name] ?? "",
  }));
}

function findPromptExample(
  promptName: string | null,
): LearningPromptExample | null {
  if (!promptName) {
    return null;
  }

  return (
    learningExampleManifest.prompts.find(
      (example) => example.targetName === promptName,
    ) ?? null
  );
}

export function LearningPromptsExplorer({
  autoConnect = true,
  serverId,
  serverUrl,
}: LearningPromptsExplorerProps) {
  const learningServer = useLearningServer({
    autoConnect,
    serverId,
    serverUrl,
  });
  const [prompts, setPrompts] = useState<MCPPrompt[]>([]);
  const [selectedPromptName, setSelectedPromptName] = useState(
    learningExampleManifest.prompts[0]?.targetName ?? "",
  );
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    learningExampleManifest.prompts[0]?.id ?? null,
  );
  const [fields, setFields] = useState<PromptField[]>([]);
  const [rawArguments, setRawArguments] = useState(
    learningExampleManifest.prompts[0]?.rawArguments ?? "{}",
  );
  const [mode, setMode] = useState<"guided" | "raw">("guided");
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [error, setError] = useState("");
  const [promptContent, setPromptContent] = useState<unknown>(null);

  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => prompt.name === selectedPromptName) ?? null,
    [prompts, selectedPromptName],
  );
  const selectedExample = useMemo(
    () => {
      const matchingSelectedExample = learningExampleManifest.prompts.find(
        (example) =>
          example.id === selectedExampleId &&
          example.targetName === selectedPromptName,
      );

      return matchingSelectedExample ?? findPromptExample(selectedPromptName);
    },
    [selectedExampleId, selectedPromptName],
  );
  const displayValue = useMemo(() => {
    const content =
      promptContent &&
      typeof promptContent === "object" &&
      "content" in (promptContent as Record<string, unknown>)
        ? (promptContent as { content?: unknown }).content
        : promptContent;
    const display = extractDisplayFromValue(content);

    if (display?.kind === "json") {
      return display.value;
    }
    if (display?.kind === "text") {
      return display.text;
    }
    return promptContent;
  }, [promptContent]);

  useEffect(() => {
    if (!learningServer.isConnected) {
      return;
    }

    let cancelled = false;
    const fetchPrompts = async () => {
      setLoadingPrompts(true);
      setError("");

      try {
        const response = await listPrompts(learningServer.serverId);
        if (cancelled) {
          return;
        }

        setPrompts(response);
        const availablePromptNames = response.map((prompt) => prompt.name);
        const preferredPrompt =
          learningExampleManifest.prompts.find((example) =>
            availablePromptNames.includes(example.targetName),
          )?.targetName ??
          availablePromptNames[0] ??
          "";
        setSelectedPromptName((current) =>
          current && availablePromptNames.includes(current)
            ? current
            : preferredPrompt,
        );
      } catch (fetchError) {
        if (!cancelled) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to fetch prompts.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingPrompts(false);
        }
      }
    };

    void fetchPrompts();

    return () => {
      cancelled = true;
    };
  }, [learningServer.isConnected, learningServer.serverId]);

  useEffect(() => {
    setFields(buildPromptFields(selectedPrompt, selectedExample));
    setRawArguments(
      selectedExample?.rawArguments ??
        JSON.stringify(selectedExample?.defaultArguments ?? {}, null, 2),
    );
  }, [selectedExample, selectedPrompt]);

  const runPrompt = useCallback(async () => {
    if (!selectedPromptName) {
      return;
    }

    setLoadingPrompt(true);
    setError("");

    try {
      const argumentsMap =
        mode === "raw"
          ? (JSON.parse(rawArguments || "{}") as Record<string, string>)
          : fields.reduce(
              (acc, field) => {
                if (field.value.trim().length > 0) {
                  acc[field.name] = field.value;
                }
                return acc;
              },
              {} as Record<string, string>,
            );
      const response = await getPrompt(
        learningServer.serverId,
        selectedPromptName,
        argumentsMap,
      );
      setPromptContent(response);
    } catch (promptError) {
      setError(
        promptError instanceof Error
          ? promptError.message
          : "Failed to fetch prompt content.",
      );
    } finally {
      setLoadingPrompt(false);
    }
  }, [fields, learningServer.serverId, mode, rawArguments, selectedPromptName]);

  const sidebar = (
    <div className="h-full border-r border-border bg-background">
      <ScrollArea className="h-full">
        <div className="space-y-4 p-4">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Guided examples
            </p>
            {learningExampleManifest.prompts.map((example) => {
              const active = example.id === selectedExampleId;
              return (
                <button
                  key={example.id}
                  type="button"
                  onClick={() => {
                    setSelectedExampleId(example.id);
                    setSelectedPromptName(example.targetName);
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
            {prompts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {loadingPrompts
                  ? "Loading prompts from the sandbox server..."
                  : "No prompts discovered yet."}
              </p>
            ) : (
              prompts.map((prompt) => (
                <button
                  key={prompt.name}
                  type="button"
                  onClick={() => {
                    setSelectedExampleId(null);
                    setSelectedPromptName(prompt.name);
                    setMode("guided");
                  }}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors",
                    selectedPromptName === prompt.name && mode === "guided"
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{prompt.name}</span>
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {prompt.description || "No description provided."}
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
      id="learning-prompts"
      title="Learning sandbox: prompts"
      description="Compare guided prompt arguments with raw JSON argument payloads while the shared logger captures the prompt RPC flow."
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
              : (learningServer.error ??
                "The learning server is not connected. Reconnect to continue.")
          }
          className="h-full"
        />
      ) : !selectedPrompt ? (
        <EmptyState
          icon={MessageSquare}
          title="No prompt selected"
          description="Pick one of the guided examples or a discovered prompt to begin."
          className="h-full"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card className="gap-4 py-4">
            <CardHeader className="px-4 pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-sm">
                    {selectedPrompt.name}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {selectedExample?.objective ??
                      selectedPrompt.description ??
                      "Prompt arguments are sent as a separate RPC request and return content for the client to use elsewhere."}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => void runPrompt()}
                  disabled={loadingPrompt}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {loadingPrompt ? "Fetching..." : "Get prompt"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 px-4">
              <Tabs
                value={mode}
                onValueChange={(value) => setMode(value as "guided" | "raw")}
              >
                <TabsList>
                  <TabsTrigger value="guided">Guided args</TabsTrigger>
                  <TabsTrigger value="raw">Raw JSON</TabsTrigger>
                </TabsList>
                <TabsContent value="guided" className="space-y-3">
                  {(fields.length === 0
                    ? [{ name: "No arguments", required: false, value: "" }]
                    : fields
                  ).map((field) => (
                    <div key={field.name} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{field.name}</span>
                        {field.required ? (
                          <Badge variant="outline">required</Badge>
                        ) : null}
                      </div>
                      {field.description ? (
                        <p className="text-xs text-muted-foreground">
                          {field.description}
                        </p>
                      ) : null}
                      {field.name === "No arguments" ? null : (
                        <Input
                          value={field.value}
                          onChange={(event) =>
                            setFields((current) =>
                              current.map((currentField) =>
                                currentField.name === field.name
                                  ? {
                                      ...currentField,
                                      value: event.target.value,
                                    }
                                  : currentField,
                              ),
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="raw" className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Send raw JSON argument maps to inspect prompt validation and
                    missing-argument behavior.
                  </p>
                  <div className="h-64 overflow-hidden rounded-lg border border-border/60">
                    <JsonEditor
                      rawContent={rawArguments}
                      onRawChange={setRawArguments}
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
              <CardTitle className="text-sm">Prompt content</CardTitle>
              <CardDescription className="text-xs">
                The server response is shown exactly as returned so learners can
                compare the prompt payload with the logger output.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              <div className="h-[28rem] overflow-hidden rounded-lg border border-border/60">
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
