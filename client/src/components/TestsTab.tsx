import { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { Save as SaveIcon, Play, Trash2, Copy, Plus, X } from "lucide-react";
import { ModelSelector } from "./chat/model-selector";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { detectOllamaModels } from "@/lib/ollama-utils";
import {
  MastraMCPServerDefinition,
  ModelDefinition,
  SUPPORTED_MODELS,
  Model,
} from "@/shared/types.js";
import {
  listSavedTests,
  saveTest,
  deleteTest,
  duplicateTest,
  type SavedTest,
} from "@/lib/test-storage";

interface TestsTabProps {
  serverConfig?: MastraMCPServerDefinition;
  serverConfigsMap?: Record<string, MastraMCPServerDefinition>;
  allServerConfigsMap?: Record<string, MastraMCPServerDefinition>;
}

type TestRunStatus = "idle" | "running" | "success" | "failed";

export function TestsTab({
  serverConfig,
  serverConfigsMap,
  allServerConfigsMap,
}: TestsTabProps) {
  const { hasToken, getToken, getOllamaBaseUrl } = useAiProviderKeys();

  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelDefinition[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelDefinition | null>(
    null,
  );
  const [currentApiKey, setCurrentApiKey] = useState<string>("");

  const [title, setTitle] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [expectedToolsInput, setExpectedToolsInput] = useState<string>("");
  const [selectedServersForTest, setSelectedServersForTest] = useState<
    string[]
  >([]);
  const [advInstructions, setAdvInstructions] = useState<string>("");
  const [advTemperature, setAdvTemperature] = useState<string>("");
  const [advMaxSteps, setAdvMaxSteps] = useState<string>("");
  const [advToolChoice, setAdvToolChoice] = useState<
    "auto" | "none" | "required"
  >("auto");
  const [configMode, setConfigMode] = useState<"basic" | "advanced">("basic");

  const [savedTests, setSavedTests] = useState<SavedTest[]>([]);
  const [editingTestId, setEditingTestId] = useState<string | null>(null);

  const [runStatus, setRunStatus] = useState<TestRunStatus>("idle");
  const [runAllStatus, setRunAllStatus] = useState<TestRunStatus>("idle");
  const [runAbortController, setRunAbortController] =
    useState<AbortController | null>(null);
  const [runAllAbortController, setRunAllAbortController] =
    useState<AbortController | null>(null);
  const [lastRunInfo, setLastRunInfo] = useState<{
    calledTools: string[];
    unexpectedTools: string[];
    missingTools: string[];
  } | null>(null);
  const [traceEvents, setTraceEvents] = useState<
    Array<{
      step: number;
      text?: string;
      toolCalls?: any[];
      toolResults?: any[];
    }>
  >([]);
  const [lastRunAll, setLastRunAll] = useState<{
    startedAt: number;
    passed: boolean | null;
    results: Array<{
      testId: string;
      title: string;
      passed: boolean;
      calledTools: string[];
      missingTools: string[];
      unexpectedTools: string[];
    }>;
    traces: Record<
      string,
      Array<{
        step: number;
        text?: string;
        toolCalls?: any[];
        toolResults?: any[];
      }>
    >;
  } | null>(null);
  const [leftTab, setLeftTab] = useState<"tests" | "runs">("tests");

  // Determine if current editor state differs from the saved version of the selected test
  const isEditingDirty = useMemo(() => {
    if (!editingTestId) return false;
    const saved = savedTests.find((t) => t.id === editingTestId);
    if (!saved) return false;
    const expectedToolsNow = parseExpectedTools(expectedToolsInput);
    const toolsEqual =
      expectedToolsNow.length === saved.expectedTools.length &&
      expectedToolsNow.every((t) => saved.expectedTools.includes(t));
    const selectedA = (saved.selectedServers || []).slice().sort();
    const selectedB = (selectedServersForTest || []).slice().sort();
    const serversEqual =
      selectedA.length === selectedB.length &&
      selectedA.every((v, i) => v === selectedB[i]);
    const modelEqual = (saved.modelId || null) === (currentModel?.id || null);
    const advEqual =
      (saved.advancedConfig?.instructions || "") === (advInstructions || "") &&
      (saved.advancedConfig?.temperature ?? "") ===
        (advTemperature.trim() === "" ? "" : Number(advTemperature)) &&
      (saved.advancedConfig?.maxSteps ?? "") ===
        (advMaxSteps.trim() === "" ? "" : Number(advMaxSteps)) &&
      (saved.advancedConfig?.toolChoice || "auto") === advToolChoice;
    return (
      saved.title !== title.trim() ||
      (saved.prompt || "") !== (prompt || "").trim() ||
      !toolsEqual ||
      !serversEqual ||
      !modelEqual ||
      !advEqual
    );
  }, [
    editingTestId,
    savedTests,
    title,
    prompt,
    expectedToolsInput,
    selectedServersForTest,
    currentModel,
    advInstructions,
    advTemperature,
    advMaxSteps,
    advToolChoice,
  ]);

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

  const handleCancelRun = useCallback(() => {
    if (runAbortController) {
      runAbortController.abort();
      setRunAbortController(null);
      setRunStatus("idle");
    }
  }, [runAbortController]);

  const handleCancelRunAll = useCallback(() => {
    if (runAllAbortController) {
      runAllAbortController.abort();
      setRunAllAbortController(null);
      setRunAllStatus("idle");
    }
  }, [runAllAbortController]);

  const getServerSelectionMap = () => {
    // If the per-test picker has selections, use those.
    if (selectedServersForTest.length > 0 && allServerConfigsMap) {
      const map: Record<string, MastraMCPServerDefinition> = {};
      for (const name of selectedServersForTest) {
        if (allServerConfigsMap[name]) map[name] = allServerConfigsMap[name];
      }
      return map;
    }
    // Otherwise, default to ALL connected servers if available
    if (allServerConfigsMap && Object.keys(allServerConfigsMap).length > 0) {
      return allServerConfigsMap;
    }
    // Fallback to whatever was passed from app (may be a subset)
    return serverConfigsMap;
  };

  // Validate server availability for current test configuration
  const validateServerAvailability = () => {
    if (!allServerConfigsMap || selectedServersForTest.length === 0)
      return { isValid: true, missingServers: [] };

    const availableServers = Object.keys(allServerConfigsMap);
    const missingServers = selectedServersForTest.filter(
      (serverName) => !availableServers.includes(serverName),
    );

    return {
      isValid: missingServers.length === 0,
      missingServers,
    };
  };

  // Discover models (mirrors logic from useChat)
  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels: models } =
        await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);
      const modelDefs: ModelDefinition[] = models.map((modelName) => ({
        id: modelName,
        name: modelName,
        provider: "ollama" as const,
      }));
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
      if (model.provider === "anthropic" && hasToken("anthropic"))
        models.push(model);
      else if (model.provider === "openai" && hasToken("openai"))
        models.push(model);
      else if (model.provider === "deepseek" && hasToken("deepseek"))
        models.push(model);
      else if (model.provider === "google" && hasToken("google"))
        models.push(model);
    }
    if (isOllamaRunning && ollamaModels.length > 0)
      models.push(...ollamaModels);
    setAvailableModels(models);

    // Ensure a valid default selection
    if (!currentModel || !models.find((m) => m.id === currentModel.id)) {
      if (isOllamaRunning && ollamaModels.length > 0)
        setCurrentModel(ollamaModels[0]);
      else if (hasToken("anthropic"))
        setCurrentModel(
          SUPPORTED_MODELS.find(
            (m) => m.id === Model.CLAUDE_3_5_SONNET_LATEST,
          ) || null,
        );
      else if (hasToken("openai"))
        setCurrentModel(
          SUPPORTED_MODELS.find((m) => m.id === Model.GPT_4O) || null,
        );
      else if (hasToken("deepseek"))
        setCurrentModel(
          SUPPORTED_MODELS.find((m) => m.id === Model.DEEPSEEK_CHAT) || null,
        );
      else if (hasToken("google"))
        setCurrentModel(
          SUPPORTED_MODELS.find((m) => m.id === Model.GEMINI_2_5_FLASH) || null,
        );
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
      const isAvailable =
        isOllamaRunning &&
        ollamaModels.some(
          (om) =>
            om.id === currentModel.id ||
            om.id.startsWith(`${currentModel.id}:`),
        );
      setCurrentApiKey(isAvailable ? "local" : "");
      return;
    }
    setCurrentApiKey(getToken(currentModel.provider));
  }, [currentModel, getToken, isOllamaRunning, ollamaModels]);

  // Load saved tests when server changes
  useEffect(() => {
    setSavedTests(listSavedTests(serverKey));
  }, [serverKey]);

  function parseExpectedTools(input: string): string[] {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

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
      advancedConfig: {
        instructions: advInstructions.trim() || undefined,
        temperature:
          advTemperature.trim() === "" ? null : Number(advTemperature),
        maxSteps: advMaxSteps.trim() === "" ? null : Number(advMaxSteps),
        toolChoice: advToolChoice,
      },
    });
    setSavedTests(listSavedTests(serverKey));
    // Keep editing the same test so dirty detection continues to work
    setEditingTestId(saved.id);
    if (!editingTestId) {
      // Clear editor for next test
      setTitle("");
      setPrompt("");
      setExpectedToolsInput("");
      setAdvInstructions("");
      setAdvTemperature("");
      setAdvMaxSteps("");
      setAdvToolChoice("auto");
    }
  };

  const handleLoad = (test: SavedTest) => {
    setEditingTestId(test.id);
    setTitle(test.title);
    setPrompt(test.prompt);
    setExpectedToolsInput(test.expectedTools.join(", "));
    // Restore per-test server selection
    setSelectedServersForTest(test.selectedServers || []);
    // Restore advanced config
    setAdvInstructions(test.advancedConfig?.instructions || "");
    setAdvTemperature(
      typeof test.advancedConfig?.temperature === "number"
        ? String(test.advancedConfig!.temperature)
        : "",
    );
    setAdvMaxSteps(
      typeof test.advancedConfig?.maxSteps === "number"
        ? String(test.advancedConfig!.maxSteps)
        : "",
    );
    setAdvToolChoice((test.advancedConfig?.toolChoice as any) || "auto");
    // Reset per-test run UI state when switching tests
    setRunStatus("idle");
    setLastRunInfo(null);
    setTraceEvents([]);
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
      // Default selection: explicitly select ALL available servers
      const defaultSelectedServers: string[] = allServerConfigsMap
        ? Object.keys(allServerConfigsMap)
        : serverConfigsMap
          ? Object.keys(serverConfigsMap)
          : [];

      // Create a placeholder saved test immediately so it appears in the left list
      const saved = saveTest(serverKey, {
        title: "Untitled test",
        description: undefined,
        prompt: "",
        expectedTools: [],
        modelId: currentModel?.id,
        selectedServers: defaultSelectedServers,
      });

      setSavedTests(listSavedTests(serverKey));
      setLeftTab("tests");
      setEditingTestId(saved.id);
      setTitle(saved.title);
      setPrompt("");
      setExpectedToolsInput("");
      setSelectedServersForTest(defaultSelectedServers);
    } catch {}
  };

  const runTest = useCallback(async () => {
    const selectionMap = getServerSelectionMap();
    const hasServers =
      (selectionMap && Object.keys(selectionMap).length > 0) || serverConfig;
    if (!hasServers || !currentModel || !currentApiKey || !prompt.trim())
      return;

    // Create abort controller for this run
    const abortController = new AbortController();
    setRunAbortController(abortController);
    setRunStatus("running");
    setLastRunInfo(null);
    setTraceEvents([]);

    const expectedSet = new Set(parseExpectedTools(expectedToolsInput));
    const calledToolsSet = new Set<string>();

    try {
      const response = await fetch("/api/mcp/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          serverConfigs:
            selectionMap && Object.keys(selectionMap).length > 0
              ? selectionMap
              : { test: serverConfig },
          model: currentModel,
          provider: currentModel?.provider,
          apiKey: currentApiKey,
          systemPrompt:
            advInstructions.trim() ||
            "You are a helpful assistant with access to MCP tools.",
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              content: prompt.trim(),
              timestamp: Date.now(),
            },
          ],
          ollamaBaseUrl: getOllamaBaseUrl(),
          temperature:
            advTemperature.trim() === "" ? undefined : Number(advTemperature),
          maxSteps: advMaxSteps.trim() === "" ? undefined : Number(advMaxSteps),
          toolChoice: advToolChoice,
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
                if (
                  (parsed.type === "tool_call" ||
                    (!parsed.type && parsed.toolCall)) &&
                  parsed.toolCall
                ) {
                  const toolCall = parsed.toolCall;
                  const toolName = toolCall?.name || toolCall?.toolName;
                  if (toolName) {
                    console.log(
                      `[Individual Test Debug] Raw tool call: "${toolName}"`,
                    );
                    calledToolsSet.add(toolName);
                  }
                }

                // Capture trace events - handle multiple formats
                if (
                  parsed.type === "trace_step" &&
                  typeof parsed.step === "number"
                ) {
                  setTraceEvents((prev) => [
                    ...prev,
                    {
                      step: parsed.step,
                      text: parsed.text,
                      toolCalls: parsed.toolCalls,
                      toolResults: parsed.toolResults,
                    },
                  ]);
                } else if (
                  parsed.type === "text" ||
                  parsed.type === "content"
                ) {
                  // Capture text responses as trace events
                  setTraceEvents((prev) => [
                    ...prev,
                    {
                      step: prev.length + 1,
                      text:
                        parsed.text || parsed.content || JSON.stringify(parsed),
                      toolCalls: [],
                      toolResults: [],
                    },
                  ]);
                } else if (!parsed.type && (parsed.text || parsed.content)) {
                  // Capture any text content without explicit type
                  setTraceEvents((prev) => [
                    ...prev,
                    {
                      step: prev.length + 1,
                      text: parsed.text || parsed.content,
                      toolCalls: [],
                      toolResults: [],
                    },
                  ]);
                }

                // Debug: log all parsed events to console
                if (parsed.type) {
                  console.log("[Test Trace]", parsed.type, parsed);
                }
              } catch {
                // ignore malformed line
              }
            }
          }
        }
      }

      const calledTools = Array.from(calledToolsSet);
      const missingTools = Array.from(expectedSet).filter(
        (t) => !calledToolsSet.has(t),
      );
      const unexpectedTools = calledTools.filter((t) => !expectedSet.has(t));

      setLastRunInfo({ calledTools, missingTools, unexpectedTools });
      setRunStatus(
        missingTools.length === 0 && unexpectedTools.length === 0
          ? "success"
          : "failed",
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Test run was cancelled");
        setRunStatus("idle");
      } else {
        console.error("Test execution error:", error);
        setRunStatus("failed");
      }
    } finally {
      setRunAbortController(null);
    }
  }, [
    serverConfig,
    serverConfigsMap,
    allServerConfigsMap,
    selectedServersForTest,
    currentModel,
    currentApiKey,
    prompt,
    expectedToolsInput,
    getOllamaBaseUrl,
    advInstructions,
    advTemperature,
    advMaxSteps,
    advToolChoice,
  ]);

  // Helper to resolve model+apiKey for a given modelId or fallback to current
  const resolveModelAndApiKey = useCallback(
    (
      modelId?: string | null,
    ): { model: ModelDefinition | null; apiKey: string } => {
      let model: ModelDefinition | null = null;
      if (modelId) {
        model = availableModels.find((m) => m.id === modelId) || null;
      }
      if (!model) model = currentModel;
      if (!model) return { model: null, apiKey: "" };
      if (model.provider === "ollama") {
        const isAvailable =
          isOllamaRunning &&
          ollamaModels.some(
            (om) => om.id === model!.id || om.id.startsWith(`${model!.id}:`),
          );
        return { model, apiKey: isAvailable ? "local" : "" };
      }
      return { model, apiKey: getToken(model.provider) };
    },
    [availableModels, currentModel, getToken, isOllamaRunning, ollamaModels],
  );

  // Run all saved tests in the current list; if any test fails, mark run failed and load first failing test details
  const runAllTests = useCallback(async () => {
    if (savedTests.length === 0) return;

    // Create abort controller for this batch run
    const abortController = new AbortController();
    setRunAllAbortController(abortController);
    setRunAllStatus("running");

    // Prepare payload for server orchestrated run
    const testsPayload = savedTests.map((t) => {
      const { model } = resolveModelAndApiKey(t.modelId);
      return {
        id: t.id,
        title: t.title,
        prompt: t.prompt || "",
        expectedTools: t.expectedTools || [],
        model: model!,
        selectedServers: t.selectedServers || [],
      };
    });
    const providerApiKeys = {
      anthropic: getToken("anthropic"),
      openai: getToken("openai"),
      deepseek: getToken("deepseek"),
      google: getToken("google"),
    } as any;

    // Consolidate all servers map from props
    const allServers =
      allServerConfigsMap ||
      serverConfigsMap ||
      (serverConfig ? { test: serverConfig } : {});

    // Validate server availability for batch tests
    const availableServerNames = Object.keys(allServers);
    const testsWithMissingServers = testsPayload
      .filter((test) => test.selectedServers && test.selectedServers.length > 0)
      .map((test) => ({
        ...test,
        missingServers: test.selectedServers!.filter(
          (serverName) => !availableServerNames.includes(serverName),
        ),
      }))
      .filter((test) => test.missingServers.length > 0);

    if (testsWithMissingServers.length > 0) {
      const testNames = testsWithMissingServers.map((t) => t.title || t.id);
      const allMissingServers = [
        ...new Set(testsWithMissingServers.flatMap((t) => t.missingServers)),
      ];

      const proceed = confirm(
        `Warning: ${testsWithMissingServers.length} test(s) have unavailable servers:\n\n` +
          `Tests: ${testNames.join(", ")}\n` +
          `Missing servers: ${allMissingServers.join(", ")}\n\n` +
          `These tests will likely fail. Do you want to continue anyway?`,
      );

      if (!proceed) {
        setRunAllStatus("idle");
        setRunAllAbortController(null);
        return;
      }
    }

    try {
      const response = await fetch("/api/mcp/tests/run-all", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          tests: testsPayload,
          allServers,
          providerApiKeys,
          ollamaBaseUrl: getOllamaBaseUrl(),
          concurrency: 6,
        }),
      });
      if (!response.ok) {
        setRunAllStatus("failed");
        return;
      }
      const runStartedAt = Date.now();
      const resultsById: Record<
        string,
        {
          testId: string;
          title: string;
          passed: boolean;
          calledTools: string[];
          missingTools: string[];
          unexpectedTools: string[];
        }
      > = {};
      const tracesById: Record<
        string,
        Array<{
          step: number;
          text?: string;
          toolCalls?: any[];
          toolResults?: any[];
        }>
      > = {};
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
                if (parsed.type === "trace_step") {
                  // When server streams trace per test, if current test is selected, append; otherwise ignore
                  if (editingTestId && parsed.testId === editingTestId) {
                    setTraceEvents((prev) => [
                      ...prev,
                      {
                        step: parsed.step,
                        text: parsed.text,
                        toolCalls: parsed.toolCalls,
                        toolResults: parsed.toolResults,
                      },
                    ]);
                  }
                  if (!tracesById[parsed.testId])
                    tracesById[parsed.testId] = [];
                  tracesById[parsed.testId].push({
                    step: parsed.step,
                    text: parsed.text,
                    toolCalls: parsed.toolCalls,
                    toolResults: parsed.toolResults,
                  });
                } else if (parsed.type === "result") {
                  // If this result belongs to the selected test, reflect its result
                  if (editingTestId && parsed.testId === editingTestId) {
                    setLastRunInfo({
                      calledTools: parsed.calledTools || [],
                      missingTools: parsed.missingTools || [],
                      unexpectedTools: parsed.unexpectedTools || [],
                    });
                  }
                  if (parsed.passed === false && !editingTestId) {
                    // Focus first failing test if none selected
                    const t = savedTests.find((s) => s.id === parsed.testId);
                    if (t) handleLoad(t);
                  }
                  const title =
                    savedTests.find((s) => s.id === parsed.testId)?.title ||
                    parsed.testId;
                  resultsById[parsed.testId] = {
                    testId: parsed.testId,
                    title,
                    passed: !!parsed.passed,
                    calledTools: parsed.calledTools || [],
                    missingTools: parsed.missingTools || [],
                    unexpectedTools: parsed.unexpectedTools || [],
                  };
                } else if (parsed.type === "run_complete") {
                  setRunAllStatus(parsed.passed ? "success" : "failed");
                  setLastRunAll({
                    startedAt: runStartedAt,
                    passed: !!parsed.passed,
                    results: Object.values(resultsById),
                    traces: tracesById,
                  });
                }
              } catch {}
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Batch test run was cancelled");
        setRunAllStatus("idle");
      } else {
        console.error("Batch test execution error:", error);
        setRunAllStatus("failed");
      }
    } finally {
      setRunAllAbortController(null);
    }
  }, [
    savedTests,
    resolveModelAndApiKey,
    allServerConfigsMap,
    serverConfigsMap,
    serverConfig,
    getOllamaBaseUrl,
    getToken,
    editingTestId,
    handleLoad,
  ]);

  const loadFromRunAll = useCallback(
    (testId: string) => {
      if (!lastRunAll) return;
      const t = savedTests.find((s) => s.id === testId);
      const r = lastRunAll.results.find((x) => x.testId === testId);
      if (t && r) {
        handleLoad(t);
        setLastRunInfo({
          calledTools: r.calledTools,
          missingTools: r.missingTools,
          unexpectedTools: r.unexpectedTools,
        });
        setTraceEvents(lastRunAll.traces[testId] || []);
      }
    },
    [lastRunAll, savedTests, handleLoad],
  );

  if (
    !(
      serverConfig ||
      (serverConfigsMap && Object.keys(serverConfigsMap).length > 0) ||
      (allServerConfigsMap && Object.keys(allServerConfigsMap).length > 0)
    )
  ) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground font-medium">
            Please select one or more servers to run tests
          </p>
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
            onClick={
              runAllStatus === "running" ? handleCancelRunAll : runAllTests
            }
            variant={runAllStatus === "running" ? "secondary" : "outline"}
            size="sm"
            disabled={savedTests.length === 0}
          >
            {runAllStatus === "running" ? (
              <>
                <X className="h-3 w-3 mr-1.5" />
                <span className="font-mono text-xs">Cancel</span>
              </>
            ) : (
              <>
                <span className="font-mono text-xs">Run All</span>
              </>
            )}
          </Button>
          <Button
            onClick={runStatus === "running" ? handleCancelRun : runTest}
            disabled={
              !currentModel ||
              !currentApiKey ||
              !prompt.trim() ||
              !validateServerAvailability().isValid
            }
            variant={runStatus === "running" ? "secondary" : "default"}
            size="sm"
            className="cursor-pointer"
          >
            {runStatus === "running" ? (
              <>
                <X className="h-3 w-3 mr-1.5" />
                <span className="font-mono text-xs">Cancel</span>
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1.5" />
                <span className="font-mono text-xs">Run Test</span>
              </>
            )}
          </Button>
          {isEditingDirty && (
            <Button
              onClick={handleSave}
              variant="outline"
              size="sm"
              disabled={!prompt.trim() || !currentModel}
              aria-label="Save"
              title="Save"
              className="cursor-pointer relative"
            >
              <SaveIcon className="h-3 w-3" />
              <div className="absolute -top-1 -right-1 w-2 h-2 bg-orange-500 rounded-full border border-background" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Left: Saved Tests / Previous Run Tabs */}
          <ResizablePanel defaultSize={25} minSize={20} maxSize={50}>
            <div className="h-full border-r border-border bg-background overflow-hidden">
              <div className="px-4 py-4 border-b border-border bg-background flex items-center gap-2">
                <button
                  className={`text-xs font-semibold px-2 py-1 rounded ${leftTab === "tests" ? "bg-muted" : "hover:bg-muted/50"}`}
                  onClick={() => setLeftTab("tests")}
                >
                  Saved Tests
                  <Badge
                    variant="secondary"
                    className="text-[10px] font-mono ml-2 align-middle"
                  >
                    {savedTests.length}
                  </Badge>
                </button>
                <button
                  className={`text-xs font-semibold px-2 py-1 rounded ${leftTab === "runs" ? "bg-muted" : "hover:bg-muted/50"}`}
                  onClick={() => setLeftTab("runs")}
                >
                  Previous Run
                  {runAllStatus === "success" && (
                    <Badge className="ml-2 text-[10px] bg-green-600 hover:bg-green-700">
                      Passed
                    </Badge>
                  )}
                  {runAllStatus === "failed" && (
                    <Badge variant="destructive" className="ml-2 text-[10px]">
                      Failed
                    </Badge>
                  )}
                </button>
              </div>
              <ScrollArea className="h-[calc(100%-48px)]">
                <div className="p-2 space-y-1">
                  {leftTab === "tests" ? (
                    savedTests.length === 0 ? (
                      <div className="text-center py-6">
                        <p className="text-xs text-muted-foreground">
                          No saved tests
                        </p>
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
                              <div className="text-xs font-medium truncate">
                                {test.title}
                              </div>
                              <div className="text-[10px] text-muted-foreground truncate">
                                Model: {test.modelId || "(current)"}
                              </div>
                              {test.expectedTools.length > 0 && (
                                <div className="mt-1 flex gap-1 flex-wrap">
                                  {test.expectedTools.slice(0, 3).map((t) => (
                                    <code
                                      key={t}
                                      className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border"
                                    >
                                      {t}
                                    </code>
                                  ))}
                                  {test.expectedTools.length > 3 && (
                                    <span className="text-[10px] text-muted-foreground">
                                      +{test.expectedTools.length - 3}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDuplicate(test);
                                }}
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                              >
                                <Copy className="w-3 h-3" />
                              </Button>
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(test.id);
                                }}
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
                    )
                  ) : !lastRunAll ? (
                    <div className="text-center py-6">
                      <p className="text-xs text-muted-foreground">
                        No previous Run All. Click Run All to execute the suite.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="px-2 text-[10px] text-muted-foreground flex items-center gap-2">
                        <span>Overall:</span>
                        {lastRunAll.passed ? (
                          <Badge className="text-[10px] bg-green-600 hover:bg-green-700">
                            Passed
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">
                            Failed
                          </Badge>
                        )}
                        <span>
                          {new Date(lastRunAll.startedAt).toLocaleString()}
                        </span>
                      </div>
                      {lastRunAll.results.map((r) => (
                        <div
                          key={r.testId}
                          className="group p-2 rounded hover:bg-muted/40 mx-2 cursor-pointer"
                          onClick={() => loadFromRunAll(r.testId)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="min-w-0 pr-2">
                              <div className="text-xs font-medium truncate">
                                {r.title}
                              </div>
                              <div className="text-[10px] text-muted-foreground truncate">
                                {r.passed
                                  ? "All expected tools called"
                                  : `Missing: ${r.missingTools.join(", ") || "-"} | Unexpected: ${r.unexpectedTools.join(", ") || "-"}`}
                              </div>
                            </div>
                            {r.passed ? (
                              <Badge className="text-[10px] bg-green-600 hover:bg-green-700">
                                Passed
                              </Badge>
                            ) : (
                              <Badge
                                variant="destructive"
                                className="text-[10px]"
                              >
                                Failed
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Right: Editor and Results */}
          <ResizablePanel defaultSize={75} minSize={50}>
            <div className="h-full flex flex-col min-h-0 overflow-y-auto">
              <div className="px-6 py-5 border-b border-border bg-background">
                <div className="grid grid-cols-6 gap-4">
                  <div className="col-span-6">
                    <label className="text-[10px] text-muted-foreground font-semibold">
                      Title<span className="text-destructive ml-0.5"></span>
                    </label>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="My test case"
                      className="mt-1 text-xs"
                      aria-required="true"
                      required
                    />
                  </div>
                  <div className="col-span-6">
                    <label className="text-[10px] text-muted-foreground font-semibold">
                      Model<span className="text-destructive ml-0.5">*</span>
                    </label>
                    <div className="mt-1">
                      {availableModels.length > 0 && currentModel ? (
                        <ModelSelector
                          currentModel={currentModel}
                          availableModels={availableModels}
                          onModelChange={(m) => setCurrentModel(m)}
                        />
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          No model available
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="col-span-6">
                    <label className="text-[10px] text-muted-foreground font-semibold">
                      Prompt<span className="text-destructive ml-0.5">*</span>
                    </label>
                    <Textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Choose the prompt for this test..."
                      className="mt-1 h-24 text-xs"
                      aria-required="true"
                      required
                    />
                  </div>
                  {allServerConfigsMap &&
                    Object.keys(allServerConfigsMap).length > 1 && (
                      <div className="col-span-6">
                        <label className="text-[10px] text-muted-foreground font-semibold">
                          Servers for this test
                        </label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {Object.keys(allServerConfigsMap).map((name) => {
                            const selected =
                              selectedServersForTest.length === 0 ||
                              selectedServersForTest.includes(name);
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
                      </div>
                    )}

                  {/* Server availability validation warning */}
                  {(() => {
                    const validation = validateServerAvailability();
                    if (
                      !validation.isValid &&
                      validation.missingServers.length > 0
                    ) {
                      return (
                        <div className="col-span-6">
                          <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-xs">
                            <div className="flex items-center gap-2 text-yellow-800">
                              <div className="w-4 h-4 rounded-full bg-yellow-400 flex items-center justify-center">
                                <span className="text-yellow-800 font-bold text-[10px]">
                                  !
                                </span>
                              </div>
                              <span className="font-semibold">
                                Server(s) unavailable
                              </span>
                            </div>
                            <div className="mt-1 text-yellow-700">
                              The following servers are selected for this test
                              but not currently available:
                              <strong className="font-mono">
                                {" "}
                                {validation.missingServers.join(", ")}
                              </strong>
                            </div>
                            <div className="mt-1 text-yellow-600">
                              This test will likely fail. Please check server
                              connections or update server selection.
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="col-span-6">
                    <label className="text-[10px] text-muted-foreground font-semibold">
                      Expected tools (comma-separated)
                    </label>
                    <Input
                      value={expectedToolsInput}
                      onChange={(e) => setExpectedToolsInput(e.target.value)}
                      placeholder="toolA, toolB"
                      className="mt-1 text-xs"
                    />
                  </div>
                </div>
              </div>

              <div className="flex-1 p-6">
                {/* Config mode selector */}
                <div className="flex items-center justify-end mb-3 gap-2">
                  <label className="text-[10px] text-muted-foreground font-semibold">
                    Config
                  </label>
                  <select
                    value={configMode}
                    onChange={(e) => setConfigMode(e.target.value as any)}
                    className="text-xs border border-border rounded px-2 py-1 bg-background"
                  >
                    <option value="basic">Basic</option>
                    <option value="advanced">Advanced</option>
                  </select>
                </div>

                {/* Advanced Config */}
                {configMode === "advanced" && (
                  <div className="mb-6 border border-border rounded p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold">Advanced Config</h3>
                    </div>
                    <div className="grid grid-cols-6 gap-4">
                      <div className="col-span-6">
                        <label className="text-[10px] text-muted-foreground font-semibold">
                          Instructions (system prompt override)
                        </label>
                        <Textarea
                          value={advInstructions}
                          onChange={(e) => setAdvInstructions(e.target.value)}
                          placeholder="Optional override of agent instructions for this test"
                          className="mt-1 h-20 text-xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-muted-foreground font-semibold">
                          Temperature
                        </label>
                        <Input
                          value={advTemperature}
                          onChange={(e) => setAdvTemperature(e.target.value)}
                          placeholder="e.g. 0.2"
                          className="mt-1 text-xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-muted-foreground font-semibold">
                          Max Steps
                        </label>
                        <Input
                          value={advMaxSteps}
                          onChange={(e) => setAdvMaxSteps(e.target.value)}
                          placeholder="e.g. 10"
                          className="mt-1 text-xs"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-muted-foreground font-semibold">
                          Tool Choice
                        </label>
                        <div className="mt-1 flex gap-2 text-xs">
                          {(["auto", "none", "required"] as const).map(
                            (opt) => (
                              <button
                                key={opt}
                                type="button"
                                className={`px-2 py-1 rounded border ${advToolChoice === opt ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-foreground border-border"}`}
                                onClick={() => setAdvToolChoice(opt)}
                              >
                                {opt}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-semibold">Last Run</span>
                  {runStatus === "idle" && (
                    <Badge variant="secondary" className="text-xs">
                      Idle
                    </Badge>
                  )}
                  {runStatus === "running" && (
                    <Badge variant="secondary" className="text-xs">
                      Running
                    </Badge>
                  )}
                  {runStatus === "success" && (
                    <Badge className="text-xs bg-green-600 hover:bg-green-700">
                      Passed
                    </Badge>
                  )}
                  {runStatus === "failed" && (
                    <Badge variant="destructive" className="text-xs">
                      Failed
                    </Badge>
                  )}
                </div>

                {lastRunInfo ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs font-semibold mb-2">
                        Called tools
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {lastRunInfo.calledTools.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            None
                          </span>
                        ) : (
                          lastRunInfo.calledTools.map((t) => (
                            <code
                              key={t}
                              className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border"
                            >
                              {t}
                            </code>
                          ))
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-2">
                        Missing expected tools
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {lastRunInfo.missingTools.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            None
                          </span>
                        ) : (
                          lastRunInfo.missingTools.map((t) => (
                            <code
                              key={t}
                              className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border"
                            >
                              {t}
                            </code>
                          ))
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-2">
                        Unexpected tools
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {lastRunInfo.unexpectedTools.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            None
                          </span>
                        ) : (
                          lastRunInfo.unexpectedTools.map((t) => (
                            <code
                              key={t}
                              className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border"
                            >
                              {t}
                            </code>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Run a test to see results here
                  </div>
                )}
              </div>

              {/* Tracing Panel */}
              <div className="border-t border-border p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold">Trace</h3>
                  {traceEvents.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {traceEvents.length} steps
                    </Badge>
                  )}
                </div>
                {traceEvents.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No trace yet. Run a test to see agent steps and tool
                    activity.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {traceEvents.map((evt) => (
                      <div
                        key={evt.step}
                        className="rounded-md border border-border p-3 bg-background"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[10px] font-semibold">
                            Step {evt.step}
                          </div>
                        </div>
                        {evt.text && (
                          <div className="text-xs mb-2 whitespace-pre-wrap">
                            {evt.text}
                          </div>
                        )}
                        {evt.toolCalls && evt.toolCalls.length > 0 && (
                          <div className="mb-1">
                            <div className="text-[10px] font-semibold mb-1">
                              Tool Calls
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {evt.toolCalls.map((c, i) => (
                                <code
                                  key={i}
                                  className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded border border-border"
                                >
                                  {c.name}
                                </code>
                              ))}
                            </div>
                          </div>
                        )}
                        {evt.toolResults && evt.toolResults.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] font-semibold mb-1">
                              Tool Results
                            </div>
                            <div className="flex flex-col gap-2">
                              {evt.toolResults.map((r, i) => (
                                <div
                                  key={i}
                                  className="text-[10px] text-muted-foreground truncate"
                                >
                                  {r.error
                                    ? `Error: ${r.error}`
                                    : "Result received"}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

export default TestsTab;
