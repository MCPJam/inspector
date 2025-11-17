import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Play, Loader2, Save } from "lucide-react";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { IterationDetails } from "./iteration-details";
import { CompactIterationRow } from "./iteration-row";
import { AccuracyChart } from "./accuracy-chart";
import { TestResultsPanel } from "./test-results-panel";
import { ChartContainer } from "@/components/ui/chart";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartTooltip } from "@/components/ui/chart";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { toast } from "sonner";
import type { EvalIteration, EvalCase } from "./types";
import { formatTime, formatDuration } from "./helpers";
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
  judgeRequirement?: string;
  advancedConfig?: Record<string, unknown>;
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
  // Run History props
  selectedTestTrendData?: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
    label: string;
  }>;
  iterationsForSelectedTest?: EvalIteration[];
  selectedTestDetails?: {
    testCase: EvalCase | null;
    templateInfo?: {
      title: string;
      query: string;
      modelCount: number;
    };
  } | null;
  runs?: Array<{ _id: string }>;
  caseGroups?: Array<{ testCase: EvalCase | null }>;
  onViewRun?: (runId: string) => void;
  onTestIdChange?: (testId: string | null) => void;
  onModeChange?: (mode: "runs" | "edit") => void;
  selectedTestModelBreakdown?: Array<{
    provider: string;
    model: string;
    passed: number;
    failed: number;
    total: number;
    passRate: number;
  }>;
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
  selectedTestTrendData = [],
  iterationsForSelectedTest = [],
  selectedTestDetails,
  runs = [],
  caseGroups = [],
  onViewRun,
  onTestIdChange,
  onModeChange,
  selectedTestModelBreakdown = [],
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [activeTab, setActiveTab] = useState("edit");
  const [availableTools, setAvailableTools] = useState<
    Array<{ name: string; description?: string; inputSchema?: any }>
  >([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [currentQuickRunResult, setCurrentQuickRunResult] = useState<
    any | null
  >(null);
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

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
  }, [selectedTestCaseId]);

  // Load lastMessageRun into currentQuickRunResult when it's available
  useEffect(() => {
    if (lastMessageRunIteration) {
      setCurrentQuickRunResult(lastMessageRunIteration);
    }
  }, [lastMessageRunIteration]);

  // Sync editedTitle when currentTestCase changes
  useEffect(() => {
    if (currentTestCase) {
      setEditedTitle(currentTestCase.title);
    }
  }, [currentTestCase?.title]);

  // Initialize/reset editForm when switching to edit tab or when currentTestCase changes
  useEffect(() => {
    if (currentTestCase) {
      if (activeTab === "edit") {
        setEditForm({
          title: currentTestCase.title,
          query: currentTestCase.query,
          runs: currentTestCase.runs,
          expectedToolCalls: currentTestCase.expectedToolCalls || [],
          judgeRequirement: currentTestCase.judgeRequirement,
          advancedConfig: currentTestCase.advancedConfig,
        });
      }
    }
  }, [currentTestCase, activeTab]);

  // Get suite config for servers (to fetch available tools)
  const suiteConfig = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    {},
  ) as any;
  const suite = useMemo(() => {
    if (!suiteConfig) return null;
    return suiteConfig.find((entry: any) => entry.suite._id === suiteId)?.suite;
  }, [suiteConfig, suiteId]);

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
    setEditedTitle(currentTestCase?.title || "");
  };

  const handleTitleBlur = async () => {
    setIsEditingTitle(false);
    if (editedTitle.trim() && editedTitle !== currentTestCase?.title) {
      try {
        await updateTestCaseMutation({
          testCaseId: currentTestCase!._id,
          title: editedTitle.trim(),
        });
        toast.success("Title updated");
      } catch (error) {
        console.error("Failed to update title:", error);
        toast.error("Failed to update title");
        setEditedTitle(currentTestCase?.title || "");
      }
    } else {
      setEditedTitle(currentTestCase?.title || "");
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleTitleBlur();
    } else if (e.key === "Escape") {
      setIsEditingTitle(false);
      setEditedTitle(currentTestCase?.title || "");
    }
  };

  const handleSave = async () => {
    if (!editForm || !currentTestCase) return;

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        title: editForm.title,
        query: editForm.query,
        runs: editForm.runs,
        expectedToolCalls: editForm.expectedToolCalls,
        judgeRequirement: editForm.judgeRequirement,
        advancedConfig: editForm.advancedConfig,
      });

      toast.success("Test case updated successfully");
    } catch (error) {
      console.error("Failed to update test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to update test case",
      );
    }
  };

  // Check if there are unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!editForm || !currentTestCase) return false;
    return (
      editForm.title !== currentTestCase.title ||
      editForm.query !== currentTestCase.query ||
      editForm.runs !== currentTestCase.runs ||
      JSON.stringify(editForm.expectedToolCalls || []) !==
        JSON.stringify(currentTestCase.expectedToolCalls || []) ||
      editForm.judgeRequirement !== currentTestCase.judgeRequirement ||
      JSON.stringify(editForm.advancedConfig || {}) !==
        JSON.stringify(currentTestCase.advancedConfig || {})
    );
  }, [editForm, currentTestCase]);

  const handleQuickRun = async () => {
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

  if (!currentTestCase) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading test case...</p>
      </Card>
    );
  }

  // Use models from the test case (which come from the suite configuration)
  const modelOptions = useMemo(() => {
    const models = currentTestCase.models || [];
    return models.map((m: any) => ({
      value: `${m.provider}/${m.model}`,
      label: m.model, // Show only model name, not provider
      provider: m.provider,
    }));
  }, [currentTestCase.models]);

  return (
    <ResizablePanelGroup direction="vertical" className="h-full">
      <ResizablePanel defaultSize={40} minSize={20}>
        <div className="h-full overflow-auto">
          <div className="p-4 space-y-4">
            {/* Header with title and save button */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                {isEditingTitle ? (
                  <input
                    type="text"
                    value={editedTitle}
                    onChange={(e) => setEditedTitle(e.target.value)}
                    onBlur={handleTitleBlur}
                    onKeyDown={handleTitleKeyDown}
                    autoFocus
                    className="px-2 py-1 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-background"
                  />
                ) : (
                  <h2
                    className="text-lg font-semibold cursor-pointer"
                    onClick={handleTitleClick}
                  >
                    {currentTestCase.title}
                  </h2>
                )}
              </div>
              {activeTab === "edit" && editForm && hasUnsavedChanges && (
                <Button
                  onClick={handleSave}
                  size="sm"
                  className="gap-2 shrink-0"
                >
                  <Save className="h-4 w-4" />
                </Button>
              )}
            </div>

            <Card className="p-0 overflow-hidden">
              {/* Unified Test Case Editor - Postman-style */}

              {/* Quick Run Controls - Postman-style */}
              <div className="border-b">
                <div className="flex items-center gap-0">
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                    disabled={isRunning || modelOptions.length === 0}
                  >
                    <SelectTrigger className="h-10 rounded-none border-r-0 border-y-0 w-48 shrink-0">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-sm text-muted-foreground">
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
                  <Input
                    value={currentTestCase.query || ""}
                    readOnly
                    placeholder="Enter your prompt..."
                    className="h-10 rounded-none border-x-0 border-y-0 flex-1 font-mono text-sm"
                  />
                  <Button
                    onClick={handleQuickRun}
                    disabled={
                      !selectedModel || isRunning || !currentTestCase.query
                    }
                    className="h-10 rounded-none border-l-0 border-y-0 shrink-0 px-6"
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Running
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-2" />
                        Run
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Tabs Navigation - Postman style */}
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="w-full"
              >
                <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto p-0">
                  <TabsTrigger
                    value="edit"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2 text-sm h-9"
                  >
                    Edit
                  </TabsTrigger>
                  <TabsTrigger
                    value="history"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2 text-sm h-9"
                  >
                    Run History
                  </TabsTrigger>
                </TabsList>

                {/* Edit Tab */}
                <TabsContent value="edit" className="p-4 space-y-4 mt-0">
                  {editForm ? (
                    <>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground">
                          Query / Prompt
                        </Label>
                        <Textarea
                          value={editForm.query}
                          onChange={(e) =>
                            setEditForm({ ...editForm, query: e.target.value })
                          }
                          rows={6}
                          placeholder="Enter your test query or prompt here..."
                          className="font-mono text-sm resize-none"
                        />
                      </div>

                      <div className="space-y-4 pt-2 border-t">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">
                            Runs per test
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            value={editForm.runs}
                            onChange={(e) =>
                              setEditForm({
                                ...editForm,
                                runs: parseInt(e.target.value) || 1,
                              })
                            }
                            className="h-9"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">
                            Expected tool calls
                          </Label>
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
                      </div>
                    </>
                  ) : (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      Loading...
                    </div>
                  )}
                </TabsContent>

                {/* Run History Tab */}
                <TabsContent value="history" className="p-4 space-y-4 mt-0">
                  {/* Performance Chart */}
                  {selectedTestTrendData.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Performance across runs
                      </Label>
                      <AccuracyChart
                        data={selectedTestTrendData}
                        height="h-32"
                        showLabel={true}
                        onClick={(runId) => {
                          if (onViewRun) onViewRun(runId);
                          if (onTestIdChange) onTestIdChange(null);
                          if (onModeChange) onModeChange("runs");
                        }}
                      />
                    </div>
                  )}

                  {/* Per-Model Breakdown */}
                  {selectedTestModelBreakdown.length > 1 && (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Performance by model
                      </Label>
                      <ChartContainer
                        config={{
                          passRate: {
                            label: "Pass rate",
                            color: "var(--chart-1)",
                          },
                        }}
                        className="aspect-auto h-48 w-full"
                      >
                        <BarChart
                          data={selectedTestModelBreakdown}
                          layout="vertical"
                          margin={{ left: 0, right: 40 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            horizontal={false}
                            stroke="hsl(var(--muted-foreground) / 0.2)"
                          />
                          <XAxis
                            type="number"
                            domain={[0, 100]}
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 11 }}
                            tickFormatter={(value) => `${value}%`}
                          />
                          <YAxis
                            type="category"
                            dataKey="model"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 11 }}
                            width={120}
                          />
                          <ChartTooltip
                            cursor={false}
                            content={({ active, payload }) => {
                              if (!active || !payload || !payload.length)
                                return null;
                              const data = payload[0].payload;
                              return (
                                <div className="rounded-lg border bg-background p-2 shadow-sm">
                                  <div className="text-xs font-medium">
                                    {data.model}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {data.provider}
                                  </div>
                                  <div className="mt-1 text-xs">
                                    Pass rate:{" "}
                                    <span className="font-medium">
                                      {data.passRate}%
                                    </span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {data.passed}/{data.total} passed
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Bar
                            dataKey="passRate"
                            fill="hsl(var(--chart-1))"
                            radius={[0, 4, 4, 0]}
                            isAnimationActive={false}
                          />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}

                  {/* Iterations List */}
                  {iterationsForSelectedTest.length === 0 ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      No iterations found for this test.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Iterations
                      </Label>
                      <div className="rounded-md border bg-card text-card-foreground flex flex-col max-h-[600px]">
                        {/* Column Headers */}
                        <div className="flex items-center gap-6 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground shrink-0">
                          <div className="w-4"></div>
                          <div className="min-w-[120px] max-w-[120px]">
                            Result
                          </div>
                          <div className="min-w-[140px] max-w-[140px]">
                            Model
                          </div>
                          <div className="min-w-[60px] max-w-[60px] text-right">
                            Tools
                          </div>
                          <div className="min-w-[70px] max-w-[70px] text-right">
                            Tokens
                          </div>
                          <div className="min-w-[70px] max-w-[70px] text-right">
                            Duration
                          </div>
                        </div>
                        <div className="divide-y overflow-y-auto">
                          {iterationsForSelectedTest.map((iteration) => {
                            const isOpen = openIterationId === iteration._id;
                            const iterationRun = iteration.suiteRunId
                              ? runs.find((r) => r._id === iteration.suiteRunId)
                              : null;

                            // Get model info for this iteration
                            const iterationTestCase = iteration.testCaseId
                              ? caseGroups.find(
                                  (g) =>
                                    g.testCase?._id === iteration.testCaseId,
                                )?.testCase
                              : null;

                            const getIterationBorderColor = (
                              result: string,
                            ) => {
                              if (result === "passed")
                                return "bg-emerald-500/50";
                              if (result === "failed") return "bg-red-500/50";
                              if (result === "cancelled")
                                return "bg-zinc-300/50";
                              return "bg-amber-500/50"; // pending
                            };

                            return (
                              <div key={iteration._id}>
                                <CompactIterationRow
                                  iteration={iteration}
                                  testCase={
                                    selectedTestDetails?.testCase || null
                                  }
                                  iterationTestCase={
                                    iterationTestCase || undefined
                                  }
                                  iterationRun={iterationRun || undefined}
                                  onViewRun={onViewRun}
                                  getIterationBorderColor={
                                    getIterationBorderColor
                                  }
                                  formatTime={formatTime}
                                  formatDuration={formatDuration}
                                  isOpen={isOpen}
                                  onToggle={() => {
                                    setOpenIterationId((current) =>
                                      current === iteration._id
                                        ? null
                                        : iteration._id,
                                    );
                                  }}
                                />
                                {isOpen && (
                                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                                    <IterationDetails
                                      iteration={iteration}
                                      testCase={
                                        selectedTestDetails?.testCase || null
                                      }
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </Card>
          </div>
        </div>
      </ResizablePanel>

      {/* Results Panel - Only show in Edit tab */}
      {activeTab === "edit" && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={60} minSize={20} maxSize={80}>
            <TestResultsPanel
              iteration={currentQuickRunResult}
              testCase={currentTestCase}
              loading={isRunning}
              onClear={handleClearResult}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
