import { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Save as SaveIcon, Play, RefreshCw, Trash2, Copy, Edit2, Plus } from "lucide-react";
import { ModelSelector } from "./chat/model-selector";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { detectOllamaModels } from "@/lib/ollama-utils";
import { MastraMCPServerDefinition, ModelDefinition, SUPPORTED_MODELS, Model } from "@/shared/types.js";
import { listSavedTests, saveTest, updateTestMeta, deleteTest, duplicateTest, type SavedTest } from "@/lib/test-storage";

interface TestsTabProps {
  serverConfig?: MastraMCPServerDefinition;
  serverConfigsMap?: Record<string, MastraMCPServerDefinition>;
  allServerConfigsMap?: Record<string, MastraMCPServerDefinition>;
}

type TestRunStatus = "idle" | "running" | "success" | "failed";

export function TestsTab({ serverConfig, serverConfigsMap, allServerConfigsMap }: TestsTabProps) {
  const { hasToken, getToken, getOllamaBaseUrl } = useAiProviderKeys();

  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelDefinition[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelDefinition | null>(null);
  const [currentApiKey, setCurrentApiKey] = useState<string>("");

  const [title, setTitle] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [expectedToolsInput, setExpectedToolsInput] = useState<string>("");
  const [selectedServersForTest, setSelectedServersForTest] = useState<string[]>([]);

  const [savedTests, setSavedTests] = useState<SavedTest[]>([]);
  const [editingTestId, setEditingTestId] = useState<string | null>(null);

  const [runStatus, setRunStatus] = useState<TestRunStatus>("idle");
  const [lastRunInfo, setLastRunInfo] = useState<{
    calledTools: string[];
    unexpectedTools: string[];
    missingTools: string[];
  } | null>(null);

  const serverKey = useMemo(() => {
    try {
      const activeMap = getServerSelectionMap();
      if (activeMap && Object.keys(activeMap).length > 0) {
        const names = Object.keys(activeMap).sort();
        return `multi:${names.join(",")}`;
      }
      if (!serverConfig) return "none";
      if ((serverConfig as any).url) {
        return `http:${(serverConfig as any).url}`;
      }
      if ((serverConfig as any).command) {
        const args = ((serverConfig as any).args || []).join(" ");
        return `stdio:${(serverConfig as any).command} ${args}`.trim();
      }
      return JSON.stringify(serverConfig);
    } catch {
      return "unknown";
    }
  }, [serverConfig, serverConfigsMap, selectedServersForTest]);

  const getServerSelectionMap = () => {
    // If the per-test picker has selections, use those. Otherwise, fall back to globally selected map.
    if (selectedServersForTest.length > 0 && allServerConfigsMap) {
      const map: Record<string, MastraMCPServerDefinition> = {};
      for (const name of selectedServersForTest) {
        if (allServerConfigsMap[name]) map[name] = allServerConfigsMap[name];
      }
      return map;
    }
    return serverConfigsMap;
  };

  // Discover models (mirrors logic from useChat)
  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels: models } = await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);
      const modelDefs: ModelDefinition[] = models.map((modelName) => ({ id: modelName, name: modelName, provider: "ollama" as const }));
      setOllamaModels(modelDefs);
    };
    checkOllama();
    const interval = setInterval(checkOllama, 30000);
    return () => clearInterval(interval);
  }, [getOllamaBaseUrl]);

  // Compute available models when tokens/ollama change
  useEffect(() => {
    const models: ModelDefinition[] = [];
    for (const model of SUPPORTED_MODELS) {
      if (model.provider === "anthropic" && hasToken("anthropic")) models.push(model);
      else if (model.provider === "openai" && hasToken("openai")) models.push(model);
      else if (model.provider === "deepseek" && hasToken("deepseek")) models.push(model);
    }
    if (isOllamaRunning && ollamaModels.length > 0) models.push(...ollamaModels);
    setAvailableModels(models);

    // Ensure a valid default selection
    if (!currentModel || !models.find((m) => m.id === currentModel.id)) {
      if (isOllamaRunning && ollamaModels.length > 0) setCurrentModel(ollamaModels[0]);
      else if (hasToken("anthropic")) setCurrentModel(SUPPORTED_MODELS.find((m) => m.id === Model.CLAUDE_3_5_SONNET_LATEST) || null);
      else if (hasToken("openai")) setCurrentModel(SUPPORTED_MODELS.find((m) => m.id === Model.GPT_4O) || null);
      else if (hasToken("deepseek")) setCurrentModel(SUPPORTED_MODELS.find((m) => m.id === Model.DEEPSEEK_CHAT) || null);
      else setCurrentModel(null);
    }
  }, [hasToken, isOllamaRunning, ollamaModels]);

  // Compute API key for current model
  useEffect(() => {
    if (!currentModel) {
      setCurrentApiKey("");
      return;
    }
    if (currentModel.provider === "ollama") {
      const isAvailable = isOllamaRunning && ollamaModels.some((om) => om.id === currentModel.id || om.id.startsWith(`${currentModel.id}:`));
      setCurrentApiKey(isAvailable ? "local" : "");
      return;
    }
    setCurrentApiKey(getToken(currentModel.provider));
  }, [currentModel, getToken, isOllamaRunning, ollamaModels]);

  // Load saved tests when server changes
  useEffect(() => {
    setSavedTests(listSavedTests(serverKey));
  }, [serverKey]);

  const parseExpectedTools = (input: string): string[] =>
    input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const handleSave = () => {
    if (!title.trim() || !prompt.trim()) return;
    const expectedTools = parseExpectedTools(expectedToolsInput);
    const saved = saveTest(serverKey, {
      id: editingTestId || undefined,
      title: title.trim(),
      description: undefined,
      prompt: prompt.trim(),
      expectedTools,
      modelId: currentModel?.id,
      selectedServers: selectedServersForTest,
    });
    setSavedTests(listSavedTests(serverKey));
    setEditingTestId(null);
    // Fire-and-forget: request backend to generate a @TestAgent file for this test
    try {
      const selectionMap = getServerSelectionMap();
      const serversPayload = selectionMap && Object.keys(selectionMap).length > 0
        ? selectionMap
        : serverConfig
          ? { test: serverConfig }
          : {};
      if (Object.keys(serversPayload).length > 0 && currentModel) {
        fetch("/api/mcp/tests/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            test: {
              id: saved.id,
              title: saved.title,
              prompt: saved.prompt,
              expectedTools: saved.expectedTools,
              modelId: saved.modelId,
            },
            servers: serversPayload,
            model: currentModel,
          }),
        }).catch(() => {});
      }
    } catch {}
    if (!editingTestId) {
      // Clear editor for next test
      setTitle("");
      setPrompt("");
      setExpectedToolsInput("");
    }
  };

  const handleLoad = (test: SavedTest) => {
    setEditingTestId(test.id);
    setTitle(test.title);
    setPrompt(test.prompt);
    setExpectedToolsInput(test.expectedTools.join(", "));
    // Restore per-test server selection
    setSelectedServersForTest(test.selectedServers || []);
    if (test.modelId) {
      const target = availableModels.find((m) => m.id === test.modelId);
      if (target) setCurrentModel(target);
    }
  };

  const handleDelete = (id: string) => {
    deleteTest(serverKey, id);
    setSavedTests(listSavedTests(serverKey));
  };

  const handleDuplicate = (test: SavedTest) => {
    duplicateTest(serverKey, test.id);
    setSavedTests(listSavedTests(serverKey));
  };

  const handleNew = () => {
    try {
      const selectionMap = getServerSelectionMap();
      const serversPayload = selectionMap && Object.keys(selectionMap).length > 0
        ? selectionMap
        : serverConfig
          ? { test: serverConfig }
          : {};

      // Create a placeholder saved test immediately so it appears in the left list
      const saved = saveTest(serverKey, {
        title: "Untitled test",
        description: undefined,
        prompt: "",
        expectedTools: [],
        modelId: currentModel?.id,
        selectedServers: selectedServersForTest,
      });

      setSavedTests(listSavedTests(serverKey));
      setEditingTestId(saved.id);
      setTitle(saved.title);
      setPrompt("");
      setExpectedToolsInput("");
      setSelectedServersForTest(saved.selectedServers || []);

      // Best-effort: generate agent file for the new test as well
      if (Object.keys(serversPayload).length > 0 && currentModel) {
        fetch("/api/mcp/tests/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            test: {
              id: saved.id,
              title: saved.title,
              prompt: "",
              expectedTools: [],
              modelId: saved.modelId,
            },
            servers: serversPayload,
            model: currentModel,
          }),
        }).catch(() => {});
      }
    } catch {}
  };

  const runTest = useCallback(async () => {
    const selectionMap = getServerSelectionMap();
    const hasServers = (selectionMap && Object.keys(selectionMap).length > 0) || serverConfig;
    if (!hasServers || !currentModel || !currentApiKey || !prompt.trim()) return;

    setRunStatus("running");
    setLastRunInfo(null);

    const expectedSet = new Set(parseExpectedTools(expectedToolsInput));
    const calledToolsSet = new Set<string>();

    try {
      const response = await fetch("/api/mcp/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          serverConfigs: selectionMap && Object.keys(selectionMap).length > 0 ? selectionMap : { test: serverConfig },
          model: currentModel,
          provider: currentModel.provider,
          apiKey: currentApiKey,
          systemPrompt: "You are a helpful assistant with access to MCP tools.",
          messages: [
            { id: crypto.randomUUID(), role: "user", content: prompt.trim(), timestamp: Date.now() },
          ],
          ollamaBaseUrl: getOllamaBaseUrl(),
        }),
      });

      if (!response.ok) {
        setRunStatus("failed");
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneStreaming = false;

      if (reader) {
        while (!doneStreaming) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") {
                doneStreaming = true;
                break;
              }
              if (!data) continue;
              try {
                const parsed = JSON.parse(data);
                // Capture tool calls
                if ((parsed.type === "tool_call" || (!parsed.type && parsed.toolCall)) && parsed.toolCall) {
                  const toolCall = parsed.toolCall;
                  if (toolCall?.name) calledToolsSet.add(toolCall.name);
                  if (toolCall?.toolName) calledToolsSet.add(toolCall.toolName);
                }
              } catch {
                // ignore malformed line
              }
            }
          }
        }
      }

      const calledTools = Array.from(calledToolsSet);
      const missingTools = Array.from(expectedSet).filter((t) => !calledToolsSet.has(t));
      const unexpectedTools = calledTools.filter((t) => !expectedSet.has(t));

      setLastRunInfo({ calledTools, missingTools, unexpectedTools });
      setRunStatus(missingTools.length === 0 && unexpectedTools.length === 0 ? "success" : "failed");
    } catch {
      setRunStatus("failed");
    }
  }, [serverConfig, serverConfigsMap, selectedServersForTest, currentModel, currentApiKey, prompt, expectedToolsInput, getOllamaBaseUrl]);

  if (!(serverConfig || (serverConfigsMap && Object.keys(serverConfigsMap).length > 0) || (allServerConfigsMap && Object.keys(allServerConfigsMap).length > 0))) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground font-medium">Please select one or more servers to run tests</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      {/* Header Controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
        <div className="flex items-center gap-2" />
        <div className="flex items-center gap-2">
          <Button
            onClick={handleNew}
            variant="ghost"
            size="sm"
            className="cursor-pointer"
          >
            <Plus className="h-3 w-3 mr-1" />
            <span className="font-mono text-xs">New</span>
          </Button>
          <Button
            onClick={runTest}
            disabled={!currentModel || !currentApiKey || !prompt.trim() || runStatus === "running"}
            size="sm"
            className="cursor-pointer"
          >
            {runStatus === "running" ? (
              <>
                <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                <span className="font-mono text-xs">Running</span>
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1.5" />
                <span className="font-mono text-xs">Run Test</span>
              </>
            )}
          </Button>
          <Button
            onClick={handleSave}
            variant="outline"
            size="sm"
            disabled={!title.trim() || !prompt.trim()}
          >
            <SaveIcon className="h-3 w-3 mr-1" />
            <span className="font-mono text-xs">{editingTestId ? "Update" : "Create"}</span>
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 grid grid-cols-12">
        {/* Left: Saved Tests */}
        <div className="col-span-4 border-r border-border overflow-hidden">
          <div className="px-4 py-4 border-b border-border bg-background">
            <h2 className="text-xs font-semibold text-foreground">Saved Tests</h2>
            <Badge variant="secondary" className="text-xs font-mono ml-2">{savedTests.length}</Badge>
          </div>
          <ScrollArea className="h-[calc(100%-48px)]">
            <div className="p-2 space-y-1">
              {savedTests.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-xs text-muted-foreground">No saved tests</p>
                </div>
              ) : (
                savedTests.map((test) => (
                  <div
                    key={test.id}
                    className="group p-2 rounded hover:bg-muted/40 mx-2 cursor-pointer"
                    onClick={() => handleLoad(test)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 pr-2">
                        <div className="text-xs font-medium truncate">{test.title}</div>
                        <div className="text-[10px] text-muted-foreground truncate">Model: {test.modelId || "(current)"}</div>
                        {test.expectedTools.length > 0 && (
                          <div className="mt-1 flex gap-1 flex-wrap">
                            {test.expectedTools.slice(0, 3).map((t) => (
                              <code key={t} className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border">{t}</code>
                            ))}
                            {test.expectedTools.length > 3 && (
                              <span className="text-[10px] text-muted-foreground">+{test.expectedTools.length - 3}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          onClick={(e) => { e.stopPropagation(); setEditingTestId(test.id); updateTestMeta(serverKey, test.id, { title: test.title }); setSavedTests(listSavedTests(serverKey)); }}
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        >
                          <Edit2 className="w-3 h-3" />
                        </Button>
                        <Button
                          onClick={(e) => { e.stopPropagation(); handleDuplicate(test); }}
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <Button
                          onClick={(e) => { e.stopPropagation(); handleDelete(test.id); }}
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right: Editor and Results */}
        <div className="col-span-8 flex flex-col">
          <div className="px-6 py-5 border-b border-border bg-background">
            <div className="grid grid-cols-6 gap-4">
              <div className="col-span-6">
                <label className="text-[10px] text-muted-foreground font-semibold">Title</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My test case" className="mt-1 text-xs" />
              </div>
              <div className="col-span-6">
                <label className="text-[10px] text-muted-foreground font-semibold">Model</label>
                <div className="mt-1">
                  {availableModels.length > 0 && currentModel ? (
                    <ModelSelector
                      currentModel={currentModel}
                      availableModels={availableModels}
                      onModelChange={(m) => setCurrentModel(m)}
                    />
                  ) : (
                    <Badge variant="secondary" className="text-xs">No model available</Badge>
                  )}
                </div>
              </div>
              <div className="col-span-6">
                <label className="text-[10px] text-muted-foreground font-semibold">Prompt</label>
                <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Given this prompt..." className="mt-1 h-24 text-xs" />
              </div>
              {allServerConfigsMap && Object.keys(allServerConfigsMap).length > 1 && (
                <div className="col-span-6">
                  <label className="text-[10px] text-muted-foreground font-semibold">Servers for this test</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {Object.keys(allServerConfigsMap).map((name) => {
                      const selected = selectedServersForTest.includes(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() =>
                            setSelectedServersForTest((prev) =>
                              prev.includes(name)
                                ? prev.filter((n) => n !== name)
                                : [...prev, name],
                            )
                          }
                          className={`px-2 py-1 rounded border text-[10px] font-mono ${selected ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-foreground border-border"}`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {selectedServersForTest.length === 0 ? "Using globally selected servers" : `Selected: ${selectedServersForTest.join(", ")}`}
                  </div>
                </div>
              )}
              <div className="col-span-6">
                <label className="text-[10px] text-muted-foreground font-semibold">Expected tools (comma-separated)</label>
                <Input value={expectedToolsInput} onChange={(e) => setExpectedToolsInput(e.target.value)} placeholder="toolA, toolB" className="mt-1 text-xs" />
              </div>
            </div>
          </div>

          <div className="flex-1 p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs font-semibold">Last Run</span>
              {runStatus === "idle" && <Badge variant="secondary" className="text-xs">Idle</Badge>}
              {runStatus === "running" && <Badge variant="secondary" className="text-xs">Running</Badge>}
              {runStatus === "success" && <Badge className="text-xs bg-green-600 hover:bg-green-700">Passed</Badge>}
              {runStatus === "failed" && <Badge variant="destructive" className="text-xs">Failed</Badge>}
            </div>

            {lastRunInfo ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-semibold mb-2">Called tools</div>
                  <div className="flex gap-1 flex-wrap">
                    {lastRunInfo.calledTools.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      lastRunInfo.calledTools.map((t) => (
                        <code key={t} className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border">{t}</code>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-2">Missing expected tools</div>
                  <div className="flex gap-1 flex-wrap">
                    {lastRunInfo.missingTools.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      lastRunInfo.missingTools.map((t) => (
                        <code key={t} className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border">{t}</code>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-2">Unexpected tools</div>
                  <div className="flex gap-1 flex-wrap">
                    {lastRunInfo.unexpectedTools.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      lastRunInfo.unexpectedTools.map((t) => (
                        <code key={t} className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border">{t}</code>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Run a test to see results here</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TestsTab;


