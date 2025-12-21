import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Play, Loader2, Save } from "lucide-react";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { TestResultsPanel } from "./test-results-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";

interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean;
  scenario?: string;
  expectedOutput?: string;
  advancedConfig?: Record<string, unknown>;
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
  connectedServerNames: Set<string>;
}

const validateExpectedToolCalls = (
  toolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>,
  isNegativeTest?: boolean,
): boolean => {
  // For negative tests, no tool calls are expected - always valid
  if (isNegativeTest) {
    return true;
  }

  // Must have at least one tool call for positive tests
  if (toolCalls.length === 0) {
    return false;
  }

  // Check each tool call
  for (const toolCall of toolCalls) {
    // Tool name must not be empty
    if (!toolCall.toolName || toolCall.toolName.trim() === "") {
      return false;
    }

    // Check all argument values are not empty strings
    if (toolCall.arguments) {
      for (const value of Object.values(toolCall.arguments)) {
        // Only fail on empty strings, not other falsy values
        if (value === "") {
          return false;
        }
      }
    }
  }

  return true;
};

// JSON deep comparision
const normalizeForComparison = (value: any): any => {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForComparison(item));
  }

  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = normalizeForComparison(value[key]);
          return acc;
        },
        {} as Record<string, any>,
      );
  }

  return value;
};

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
  connectedServerNames,
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [availableTools, setAvailableTools] = useState<
    Array<{ name: string; description?: string; inputSchema?: any }>
  >([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [optimisticNegative, setOptimisticNegative] = useState<boolean | null>(
    null,
  );
  const [currentQuickRunResult, setCurrentQuickRunResult] = useState<
    any | null
  >(null);

  // Get all test cases for this suite
  const testCases = useQuery("testSuites:listTestCases" as any, {
    suiteId,
  }) as any[] | undefined;

  const updateTestCaseMutation = useMutation(
    "testSuites:updateTestCase" as any,
  );

  // Find the test case
  const currentTestCase = useMemo(() => {
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [testCases, selectedTestCaseId]);

  // Fetch the lastMessageRun iteration if it exists
  const lastMessageRunId = currentTestCase?.lastMessageRun;
  const lastMessageRunIteration = useQuery(
    "testSuites:getTestIteration" as any,
    lastMessageRunId ? { iterationId: lastMessageRunId } : "skip",
  ) as any | undefined;

  // Clear and reload currentQuickRunResult when test case changes
  useEffect(() => {
    // Clear the result when switching test cases
    setCurrentQuickRunResult(null);
    // Reset optimistic state when switching test cases
    setOptimisticNegative(null);
  }, [selectedTestCaseId]);

  // Load lastMessageRun into currentQuickRunResult when it's available
  useEffect(() => {
    if (lastMessageRunIteration) {
      setCurrentQuickRunResult(lastMessageRunIteration);
    }
  }, [lastMessageRunIteration]);

  // Initialize/reset editForm only when switching test cases (not on DB updates)
  // This preserves local edits after running tests
  useEffect(() => {
    if (currentTestCase) {
      setEditForm({
        title: currentTestCase.title,
        query: currentTestCase.query,
        runs: currentTestCase.runs,
        expectedToolCalls: currentTestCase.expectedToolCalls || [],
        isNegativeTest: currentTestCase.isNegativeTest,
        scenario: currentTestCase.scenario,
        expectedOutput: currentTestCase.expectedOutput,
        advancedConfig: currentTestCase.advancedConfig,
      });
    }
  }, [selectedTestCaseId, currentTestCase?._id]); // Reset when switching test cases or when test case first loads

  // Get suite config for servers (to fetch available tools)
  const suiteConfig = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    {},
  ) as any;
  const suite = useMemo(() => {
    if (!suiteConfig) return null;
    return suiteConfig.find((entry: any) => entry.suite._id === suiteId)?.suite;
  }, [suiteConfig, suiteId]);

  // Calculate missing servers
  const missingServers = useMemo(() => {
    if (!suite) return [];
    const suiteServers = suite.environment?.servers || [];
    return suiteServers.filter((server) => !connectedServerNames.has(server));
  }, [suite, connectedServerNames]);

  const canRun = missingServers.length === 0;

  // Fetch available tools from selected servers
  useEffect(() => {
    async function fetchTools() {
      if (!suite) return;

      const serverIds = suite.environment?.servers || [];
      if (serverIds.length === 0) {
        setAvailableTools([]);
        return;
      }

      try {
        const response = await fetch("/api/mcp/list-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverIds }),
        });

        if (response.ok) {
          const data = await response.json();
          setAvailableTools(data.tools || []);
        }
      } catch (error) {
        console.error("Failed to fetch tools:", error);
      }
    }

    fetchTools();
  }, [suite]);

  const handleTitleClick = () => {
    setIsEditingTitle(true);
  };

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleBlur();
    } else if (e.key === "Escape") {
      // Revert title to current test case value
      if (editForm && currentTestCase) {
        setEditForm({ ...editForm, title: currentTestCase.title });
      }
      setIsEditingTitle(false);
    }
  };

  // Check if there are unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!editForm || !currentTestCase) return false;

    const normalizedExpectedToolCalls = JSON.stringify(
      normalizeForComparison(editForm.expectedToolCalls || []),
    );
    const normalizedCurrentExpectedToolCalls = JSON.stringify(
      normalizeForComparison(currentTestCase.expectedToolCalls || []),
    );
    const normalizedAdvancedConfig = JSON.stringify(
      normalizeForComparison(editForm.advancedConfig || {}),
    );
    const normalizedCurrentAdvancedConfig = JSON.stringify(
      normalizeForComparison(currentTestCase.advancedConfig || {}),
    );

    return (
      editForm.title !== currentTestCase.title ||
      editForm.query !== currentTestCase.query ||
      editForm.runs !== currentTestCase.runs ||
      normalizedExpectedToolCalls !== normalizedCurrentExpectedToolCalls ||
      normalizedAdvancedConfig !== normalizedCurrentAdvancedConfig ||
      (editForm.scenario || "") !== (currentTestCase.scenario || "") ||
      (editForm.expectedOutput || "") !== (currentTestCase.expectedOutput || "")
    );
  }, [editForm, currentTestCase]);

  // Check if expected tool calls are valid
  const areExpectedToolCallsValid = useMemo(() => {
    if (!editForm) return true; // Allow saving if form is not loaded yet
    return validateExpectedToolCalls(
      editForm.expectedToolCalls || [],
      currentTestCase?.isNegativeTest,
    );
  }, [editForm, currentTestCase?.isNegativeTest]);

  // Separate save handler
  const handleSave = async () => {
    if (!editForm || !currentTestCase) return;

    // Validate expected tool calls before saving (skip for negative tests)
    if (
      !validateExpectedToolCalls(
        editForm.expectedToolCalls || [],
        currentTestCase.isNegativeTest,
      )
    ) {
      toast.error(
        "Cannot save: All tool names must be specified and argument values cannot be empty.",
      );
      return;
    }

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        title: editForm.title,
        query: editForm.query,
        runs: editForm.runs,
        expectedToolCalls: editForm.expectedToolCalls,
        scenario: editForm.scenario,
        expectedOutput: editForm.expectedOutput,
        advancedConfig: editForm.advancedConfig,
      });
      toast.success("Changes saved");
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error("Failed to save changes");
      throw error;
    }
  };

  // Standalone run handler (no auto-save)
  const handleRun = async () => {
    if (!selectedModel || !currentTestCase || !suite) return;

    // Parse the selected model (format: "provider/model")
    const [provider, ...modelParts] = selectedModel.split("/");
    const model = modelParts.join("/");

    if (!provider || !model) {
      toast.error("Invalid model selection");
      return;
    }

    // Check for API key if needed
    if (!isMCPJamProvidedModel(model)) {
      const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
      if (!hasToken(tokenKey)) {
        toast.error(
          `Please add your ${provider} API key in Settings before running this test`,
        );
        return;
      }
    }

    // Clear previous result
    setCurrentQuickRunResult(null);
    setIsRunning(true);

    // Track test case run started
    posthog.capture("eval_test_case_run_started", {
      location: "test_template_editor",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      suite_id: suiteId,
      test_case_id: currentTestCase._id,
      model: selectedModel,
    });

    try {
      const accessToken = await getAccessToken();
      const serverIds = suite.environment?.servers || [];

      // Collect API key if needed
      const modelApiKeys: Record<string, string> = {};
      if (!isMCPJamProvidedModel(model)) {
        const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
        const key = getToken(tokenKey);
        if (key) {
          modelApiKeys[provider] = key;
        }
      }

      const response = await fetch("/api/mcp/evals/run-test-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCaseId: currentTestCase._id,
          model,
          provider,
          serverIds,
          modelApiKeys:
            Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
          convexAuthToken: accessToken,
          // Send current form state to run with unsaved changes
          testCaseOverrides: editForm
            ? {
                query: editForm.query,
                expectedToolCalls: editForm.expectedToolCalls,
                runs: editForm.runs,
              }
            : undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Failed to run test case");
      }

      const data = await response.json();

      // Store the iteration result
      if (data.iteration) {
        setCurrentQuickRunResult(data.iteration);

        // Calculate duration
        const iteration = data.iteration;
        const startedAt = iteration.startedAt ?? iteration.createdAt;
        const completedAt = iteration.updatedAt ?? iteration.createdAt;
        const durationMs =
          startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : 0;

        // Track test case run completed
        posthog.capture("eval_test_case_run_completed", {
          location: "test_template_editor",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          test_case_id: currentTestCase._id,
          model: selectedModel,
          result: iteration.result || "unknown",
          duration_ms: durationMs,
        });
      }

      toast.success("Test completed successfully!");
    } catch (error) {
      console.error("Failed to run test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to run test case",
      );
    } finally {
      setIsRunning(false);
    }
  };

  // Combined save and run handler
  const handleSaveAndRun = async () => {
    if (hasUnsavedChanges) {
      try {
        await handleSave();
      } catch (error) {
        // If save fails, don't proceed with run
        return;
      }
    }
    await handleRun();
  };

  const handleClearResult = async () => {
    if (!currentTestCase) return;

    try {
      // Clear the lastMessageRun field in the database
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        lastMessageRun: null,
      });

      // Clear the local state
      setCurrentQuickRunResult(null);
      toast.success("Result cleared");
    } catch (error) {
      console.error("Failed to clear result:", error);
      toast.error("Failed to clear result");
    }
  };

  const handleToggleNegative = async () => {
    if (!currentTestCase) return;

    const newValue = !currentTestCase.isNegativeTest;
    // Optimistically update the UI immediately
    setOptimisticNegative(newValue);
    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        isNegativeTest: newValue,
        // Clear expected tool calls when converting to negative test
        ...(newValue && { expectedToolCalls: [] }),
      });
      // Clear optimistic state after server confirms (Convex query will take over)
      setOptimisticNegative(null);
    } catch (error) {
      console.error("Failed to toggle negative test:", error);
      toast.error("Failed to update test type");
      // Revert optimistic update on error
      setOptimisticNegative(null);
    }
  };

  // Use models from the test case (which come from the suite configuration)
  const modelOptions = useMemo(() => {
    if (!currentTestCase) return [];
    const models = currentTestCase.models || [];
    return models.map((m: any) => ({
      value: `${m.provider}/${m.model}`,
      label: m.model, // Show only model name, not provider
      provider: m.provider,
    }));
  }, [currentTestCase]);

  // Auto-select first model if none selected
  useEffect(() => {
    if (modelOptions.length > 0 && !selectedModel) {
      setSelectedModel(modelOptions[0].value);
    }
  }, [modelOptions, selectedModel]);

  if (!currentTestCase) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">Loading test case...</p>
      </div>
    );
  }

  return (
    <ResizablePanelGroup direction="vertical" className="h-full">
      <ResizablePanel defaultSize={40} minSize={20}>
        <div className="h-full overflow-auto">
          <div className="p-2 space-y-2">
            {/* Header with title and controls */}
            <div className="flex items-center justify-between gap-4 px-1 pb-3 border-b">
              <div className="flex-1 min-w-0">
                {isEditingTitle ? (
                  <input
                    type="text"
                    value={editForm?.title || ""}
                    onChange={(e) =>
                      editForm &&
                      setEditForm({ ...editForm, title: e.target.value })
                    }
                    onBlur={handleTitleBlur}
                    onKeyDown={handleTitleKeyDown}
                    autoFocus
                    className="px-0 py-0 text-lg font-semibold border-none focus:outline-none focus:ring-0 bg-transparent w-full"
                  />
                ) : (
                  <h2
                    className="text-lg font-semibold cursor-pointer hover:opacity-60 transition-opacity truncate"
                    onClick={handleTitleClick}
                  >
                    {editForm?.title || currentTestCase.title}
                  </h2>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Switch
                      checked={
                        optimisticNegative ??
                        currentTestCase.isNegativeTest ??
                        false
                      }
                      onCheckedChange={handleToggleNegative}
                      className="scale-75 data-[state=checked]:bg-orange-500"
                    />
                    <span
                      className={`text-[10px] ${(optimisticNegative ?? currentTestCase.isNegativeTest) ? "text-orange-500" : "text-muted-foreground"}`}
                    >
                      NEG
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {(optimisticNegative ?? currentTestCase.isNegativeTest)
                      ? "Negative test: passes when no tools are called"
                      : "Click to mark as negative test"}
                  </p>
                </TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-3 shrink-0">
                <Select
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                  disabled={isRunning || modelOptions.length === 0}
                >
                  <SelectTrigger className="h-9 text-xs border-0 bg-muted/50 hover:bg-muted transition-colors w-[180px]">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No models available
                      </div>
                    ) : (
                      modelOptions.map(
                        (option: {
                          value: string;
                          label: string;
                          provider: string;
                        }) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ),
                      )
                    )}
                  </SelectContent>
                </Select>

                {/* Save button - only show if there are unsaved changes */}
                {hasUnsavedChanges && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          onClick={handleSave}
                          disabled={isRunning || !areExpectedToolCallsValid}
                          variant="outline"
                          size="sm"
                          className="h-9 px-4 text-xs font-medium"
                        >
                          <Save className="h-3.5 w-3.5 mr-2" />
                          Save
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {!areExpectedToolCallsValid
                        ? "All tool names must be specified and argument values cannot be empty"
                        : "Save changes to this test case"}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Run button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        onClick={handleRun}
                        disabled={
                          !selectedModel ||
                          isRunning ||
                          !editForm?.query?.trim() ||
                          !canRun
                        }
                        size="sm"
                        className="h-9 px-5 text-xs font-medium shadow-sm"
                      >
                        {isRunning ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                            Running...
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 mr-2 fill-current" />
                            Run
                          </>
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!canRun
                      ? `Connect the following servers: ${missingServers.join(", ")}`
                      : !selectedModel
                        ? "Select a model to run"
                        : !editForm?.query?.trim()
                          ? "Enter a query to run"
                          : "Run this test"}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Edit Content */}
            {editForm ? (
              <>
                {/* Scenario field - shown for all tests */}
                <div className="px-1 pt-2">
                  <Label className="text-xs text-muted-foreground font-medium">
                    Scenario
                  </Label>
                  <p className="text-[10px] text-muted-foreground mb-1.5">
                    {currentTestCase?.isNegativeTest
                      ? "Describe the scenario where your app should not trigger"
                      : "Describe the use case to test"}
                  </p>
                  <Textarea
                    value={editForm.scenario || ""}
                    onChange={(e) =>
                      setEditForm({ ...editForm, scenario: e.target.value })
                    }
                    rows={2}
                    placeholder={
                      currentTestCase?.isNegativeTest
                        ? "e.g., User asks about unrelated topic..."
                        : "e.g., Check current time display..."
                    }
                    className="text-sm resize-none border-0 bg-muted/30 focus-visible:bg-muted/50 transition-colors px-3 py-2"
                  />
                </div>

                <div className="px-1 pt-3">
                  <Label className="text-xs text-muted-foreground font-medium">
                    User Prompt
                  </Label>
                  <p className="text-[10px] text-muted-foreground mb-1.5">
                    {currentTestCase?.isNegativeTest
                      ? "Example prompt where your app should not trigger"
                      : "The exact prompt or interaction to begin the test"}
                  </p>
                  <Textarea
                    value={editForm.query}
                    onChange={(e) =>
                      setEditForm({ ...editForm, query: e.target.value })
                    }
                    rows={4}
                    placeholder="Enter your test prompt here..."
                    className="font-mono text-sm resize-none border-0 bg-muted/30 focus-visible:bg-muted/50 transition-colors px-3 py-2.5"
                  />
                </div>

                {/* Tool Triggered and Expected Output - only for positive tests */}
                {!currentTestCase?.isNegativeTest && (
                  <>
                    <div className="px-1 pt-3">
                      <Label className="text-xs text-muted-foreground font-medium">
                        Tool Triggered
                      </Label>
                      <p className="text-[10px] text-muted-foreground mb-1.5">
                        Which tools should be called?
                      </p>
                      <ExpectedToolsEditor
                        toolCalls={editForm.expectedToolCalls || []}
                        onChange={(toolCalls) =>
                          setEditForm({
                            ...editForm,
                            expectedToolCalls: toolCalls,
                          })
                        }
                        availableTools={availableTools}
                      />
                    </div>

                    <div className="px-1 pt-3">
                      <Label className="text-xs text-muted-foreground font-medium">
                        Expected Output
                      </Label>
                      <p className="text-[10px] text-muted-foreground mb-1.5">
                        The output or experience we should expect to receive
                        back from the MCP server
                      </p>
                      <Textarea
                        value={editForm.expectedOutput || ""}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            expectedOutput: e.target.value,
                          })
                        }
                        rows={2}
                        placeholder="e.g., Should return pokemon data with name, type, and stats..."
                        className="text-sm resize-none border-0 bg-muted/30 focus-visible:bg-muted/50 transition-colors px-3 py-2"
                      />
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground">
                Loading...
              </div>
            )}
          </div>
        </div>
      </ResizablePanel>

      {/* Results Panel */}
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={60} minSize={20} maxSize={80}>
        <TestResultsPanel
          iteration={currentQuickRunResult}
          testCase={currentTestCase}
          loading={isRunning}
          onClear={handleClearResult}
          serverNames={(suite?.environment?.servers || []).filter((name) =>
            connectedServerNames.has(name),
          )}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
