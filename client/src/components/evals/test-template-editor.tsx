import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil, Check, X, Play, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { IterationDetails } from "./iteration-details";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiProviderKeys, type ProviderTokens } from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import { formatTime } from "./helpers";

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
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [availableTools, setAvailableTools] = useState<
    Array<{ name: string; description?: string; inputSchema?: any }>
  >([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [currentQuickRunResult, setCurrentQuickRunResult] = useState<any | null>(null);
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

  // Get all test cases for this suite
  const testCases = useQuery("evals:getTestCasesBySuite" as any, {
    suiteId,
  }) as any[] | undefined;

  const updateTestCaseMutation = useMutation("evals:updateTestCase" as any);

  // Find the test case
  const currentTestCase = useMemo(() => {
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [testCases, selectedTestCaseId]);

  // Get suite config for servers (to fetch available tools)
  const suiteConfig = useQuery("evals:getSuiteOverview" as any, {}) as any;
  const suite = useMemo(() => {
    if (!suiteConfig) return null;
    return suiteConfig.find((entry: any) => entry.suite._id === suiteId)?.suite;
  }, [suiteConfig, suiteId]);

  // Fetch available tools from selected servers
  useEffect(() => {
    async function fetchTools() {
      if (!suite) return;

      const serverIds = suite.config?.environment?.servers || [];
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

  const startEdit = () => {
    if (currentTestCase) {
      setEditForm({
        title: currentTestCase.title,
        query: currentTestCase.query,
        runs: currentTestCase.runs,
        expectedToolCalls: currentTestCase.expectedToolCalls || [],
        judgeRequirement: currentTestCase.judgeRequirement,
        advancedConfig: currentTestCase.advancedConfig,
      });
      setIsEditing(true);
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditForm(null);
  };

  const saveEdit = async () => {
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
      setIsEditing(false);
      setEditForm(null);
    } catch (error) {
      console.error("Failed to update test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to update test case"
      );
    }
  };

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
          `Please add your ${provider} API key in Settings before running this test`
        );
        return;
      }
    }

    // Clear previous result
    setCurrentQuickRunResult(null);
    setIsRunning(true);

    try {
      const accessToken = await getAccessToken();
      const serverIds = suite.config?.environment?.servers || [];

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
          modelApiKeys: Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
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
        error instanceof Error ? error.message : "Failed to run test case"
      );
    } finally {
      setIsRunning(false);
    }
  };

  if (!currentTestCase) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading test case...</p>
      </Card>
    );
  }

  const modelCount = currentTestCase.models?.length || 0;

  // Use models from the test case (which come from the suite configuration)
  const modelOptions = useMemo(() => {
    const models = currentTestCase.models || [];
    return models.map((m: any) => ({
      value: `${m.provider}/${m.model}`,
      label: `${m.provider}/${m.model}`,
      provider: m.provider,
    }));
  }, [currentTestCase.models]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        {isEditing && editForm ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={editForm.title}
              onChange={(e) =>
                setEditForm({ ...editForm, title: e.target.value })
              }
              placeholder="e.g., Add two numbers"
            />
          </div>

          <div className="space-y-2">
            <Label>Query</Label>
            <Textarea
              value={editForm.query}
              onChange={(e) =>
                setEditForm({ ...editForm, query: e.target.value })
              }
              rows={3}
              placeholder="e.g., Add 5 and 7 together"
            />
          </div>

          <div className="space-y-2">
            <Label>Runs per test</Label>
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
            />
          </div>

          <div className="space-y-2">
            <Label>Expected tool calls</Label>
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

          <div className="flex gap-2">
            <Button onClick={saveEdit} size="sm">
              <Check className="h-4 w-4 mr-2" />
              Save
            </Button>
            <Button onClick={cancelEdit} size="sm" variant="outline">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h4 className="font-semibold mb-2">Test Configuration</h4>
              <div className="space-y-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Title</div>
                  <p className="text-sm">{currentTestCase.title}</p>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Query</div>
                  <p className="text-sm italic">"{currentTestCase.query}"</p>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Badge variant="outline">{currentTestCase.runs} runs</Badge>
                  <Badge variant="outline">{modelCount} model{modelCount === 1 ? '' : 's'}</Badge>
                  {(currentTestCase.expectedToolCalls || []).length > 0 && (
                    <Badge variant="outline">
                      Expects:{" "}
                      {(currentTestCase.expectedToolCalls || [])
                        .map((t) => t.toolName)
                        .join(", ")}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <Button onClick={startEdit} size="sm" variant="ghost">
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Card>

      {/* Quick Run Section */}
      {!isEditing && (
        <Card className="p-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">Quick Run</h4>
              <Badge variant="secondary" className="text-xs">
                Test without creating a suite run
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Quickly test this case with a single model to iterate and debug.
            </p>
            <div className="flex items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="quick-run-model">Model</Label>
                <Select
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                  disabled={isRunning || modelOptions.length === 0}
                >
                  <SelectTrigger id="quick-run-model">
                    <SelectValue placeholder="Select a model..." />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No models available
                      </div>
                    ) : (
                      modelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleQuickRun}
                disabled={!selectedModel || isRunning || !currentTestCase.query}
                size="default"
                className="gap-2"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Run Test
                  </>
                )}
              </Button>
            </div>
            {!currentTestCase.query && (
              <p className="text-xs text-amber-600">
                Please add a query to the test case before running.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Quick Run Result */}
      {!isEditing && currentQuickRunResult && (
        <Card className="p-4">
          <div className="space-y-3">
            <h4 className="font-semibold">Result</h4>
            <div>
              {(() => {
                const iteration = currentQuickRunResult;
                const isPassed = iteration.result === "passed";
                const isFailed = iteration.result === "failed";
                const isPending = iteration.status === "running" || iteration.status === "pending";
                const modelName = iteration.testCaseSnapshot?.model || "Unknown";
                const provider = iteration.testCaseSnapshot?.provider || "";

                return (
                  <div>
                    <button
                      onClick={() => setOpenIterationId(openIterationId === iteration._id ? null : iteration._id)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors">
                        {/* Result Icon */}
                        <div className="shrink-0">
                          {isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                          ) : isPassed ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          ) : isFailed ? (
                            <XCircle className="h-4 w-4 text-red-600" />
                          ) : null}
                        </div>

                        {/* Model & Stats */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-mono font-medium truncate">
                              {provider}/{modelName}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {iteration.result}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                            <span>Tools: {iteration.actualToolCalls?.length || 0}</span>
                            <span>Tokens: {iteration.tokensUsed?.toLocaleString() || 0}</span>
                            <span>{formatTime(iteration.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    </button>

                    {/* Iteration Details */}
                    {openIterationId === iteration._id && (
                      <div className="mt-2 ml-7">
                        <IterationDetails
                          iteration={iteration}
                          onClose={() => setOpenIterationId(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
