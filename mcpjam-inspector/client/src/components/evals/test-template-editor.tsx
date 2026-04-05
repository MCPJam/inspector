import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { listEvalTools, runEvalTestCase } from "@/lib/apis/evals-api";
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
import { Input } from "@/components/ui/input";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { ModelDefinition } from "@/shared/types";
import {
  buildTestCaseModelOptions,
  prepareSingleTestCaseRun,
  resolveSelectedTestCaseModelValue,
  setPersistedTestCaseModelValue,
} from "./single-test-case-runner";
import {
  deriveLegacyPromptFields,
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
} from "@/shared/prompt-turns";
import { ToolChoicePicker } from "./tool-choice-picker";
import { normalizeToolChoice } from "@/shared/tool-choice";

interface TestTemplate {
  title: string;
  runs: number;
  isNegativeTest?: boolean;
  promptTurns: PromptTurn[];
  advancedConfig?: Record<string, unknown>;
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
  connectedServerNames: Set<string>;
  workspaceId: string | null;
  availableModels: ModelDefinition[];
}

const createEmptyPromptTurn = (index: number): PromptTurn => ({
  id: `turn-${Date.now()}-${index + 1}`,
  prompt: "",
  expectedToolCalls: [],
});

const validateExpectedToolCalls = (
  toolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>,
): boolean => {
  for (const toolCall of toolCalls) {
    if (!toolCall.toolName || toolCall.toolName.trim() === "") {
      return false;
    }

    for (const value of Object.values(toolCall.arguments ?? {})) {
      if (value === "") {
        return false;
      }
    }
  }

  return true;
};

const validatePromptTurns = (
  promptTurns: PromptTurn[],
  isNegativeTest?: boolean,
): boolean => {
  if (!Array.isArray(promptTurns) || promptTurns.length === 0) {
    return false;
  }

  if (promptTurns.some((turn) => !turn.prompt.trim())) {
    return false;
  }

  if (isNegativeTest) {
    return promptTurns.every((turn) => turn.expectedToolCalls.length === 0);
  }

  const assertedTurns = promptTurns.filter(
    (turn) => turn.expectedToolCalls.length > 0,
  );
  if (assertedTurns.length === 0) {
    return false;
  }

  return assertedTurns.every((turn) =>
    validateExpectedToolCalls(turn.expectedToolCalls),
  );
};

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

function normalizeAdvancedConfig(
  advancedConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const stripped = stripPromptTurnsFromAdvancedConfig(advancedConfig);
  if (!stripped) {
    return undefined;
  }

  const next = { ...stripped };

  if (typeof next.system === "string" && next.system.trim() === "") {
    delete next.system;
  }
  const normalizedToolChoice = normalizeToolChoice(next.toolChoice);
  if (!normalizedToolChoice) {
    delete next.toolChoice;
  } else {
    next.toolChoice = normalizedToolChoice;
  }
  if (
    next.temperature === null ||
    next.temperature === undefined ||
    next.temperature === ""
  ) {
    delete next.temperature;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
  connectedServerNames,
  workspaceId,
  availableModels,
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [availableTools, setAvailableTools] = useState<
    Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId?: string;
    }>
  >([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [optimisticNegative, setOptimisticNegative] = useState<boolean | null>(
    null,
  );
  const [currentQuickRunResult, setCurrentQuickRunResult] = useState<any | null>(
    null,
  );

  const testCases = useQuery("testSuites:listTestCases" as any, {
    suiteId,
  }) as any[] | undefined;
  const updateTestCaseMutation = useMutation(
    "testSuites:updateTestCase" as any,
  );

  const currentTestCase = useMemo(() => {
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [testCases, selectedTestCaseId]);

  const lastMessageRunId = currentTestCase?.lastMessageRun;
  const lastMessageRunIteration = useQuery(
    "testSuites:getTestIteration" as any,
    lastMessageRunId ? { iterationId: lastMessageRunId } : "skip",
  ) as any | undefined;

  useEffect(() => {
    setCurrentQuickRunResult(null);
    setOptimisticNegative(null);
  }, [selectedTestCaseId]);

  useEffect(() => {
    if (lastMessageRunIteration) {
      setCurrentQuickRunResult(lastMessageRunIteration);
    }
  }, [lastMessageRunIteration]);

  useEffect(() => {
    if (!currentTestCase) {
      return;
    }

    setEditForm({
      title: currentTestCase.title,
      runs: currentTestCase.runs,
      isNegativeTest: currentTestCase.isNegativeTest,
      promptTurns: resolvePromptTurns(currentTestCase),
      advancedConfig: normalizeAdvancedConfig(currentTestCase.advancedConfig),
    });
  }, [selectedTestCaseId, currentTestCase?._id]);

  const suite = useQuery("testSuites:getTestSuite" as any, {
    suiteId,
  }) as any;

  const missingServers = useMemo(() => {
    if (!suite) return [];
    const suiteServers = suite.environment?.servers || [];
    return suiteServers.filter(
      (server: string) => !connectedServerNames.has(server),
    );
  }, [suite, connectedServerNames]);

  const canRun = missingServers.length === 0;

  useEffect(() => {
    async function fetchTools() {
      if (!suite) return;

      const serverIds = suite.environment?.servers || [];
      if (serverIds.length === 0) {
        setAvailableTools([]);
        return;
      }

      try {
        const data = await listEvalTools({
          workspaceId,
          serverIds,
        });
        setAvailableTools(data.tools || []);
      } catch (error) {
        console.error("Failed to fetch tools:", error);
        setAvailableTools([]);
      }
    }

    fetchTools();
  }, [suite, workspaceId]);

  const handleTitleClick = () => {
    setIsEditingTitle(true);
  };

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleBlur();
    } else if (e.key === "Escape") {
      if (editForm && currentTestCase) {
        setEditForm({ ...editForm, title: currentTestCase.title });
      }
      setIsEditingTitle(false);
    }
  };

  const isEffectivelyNegative =
    optimisticNegative ?? editForm?.isNegativeTest ?? currentTestCase?.isNegativeTest ?? false;

  const currentPromptTurns = useMemo(
    () => (currentTestCase ? resolvePromptTurns(currentTestCase) : []),
    [currentTestCase],
  );
  const currentAdvancedConfig = useMemo(
    () => normalizeAdvancedConfig(currentTestCase?.advancedConfig),
    [currentTestCase],
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!editForm || !currentTestCase) return false;

    const normalizedPromptTurns = JSON.stringify(
      normalizeForComparison(editForm.promptTurns),
    );
    const normalizedCurrentPromptTurns = JSON.stringify(
      normalizeForComparison(currentPromptTurns),
    );
    const normalizedAdvancedConfig = JSON.stringify(
      normalizeForComparison(editForm.advancedConfig || {}),
    );
    const normalizedCurrentAdvancedConfig = JSON.stringify(
      normalizeForComparison(currentAdvancedConfig || {}),
    );

    return (
      editForm.title !== currentTestCase.title ||
      editForm.runs !== currentTestCase.runs ||
      normalizedPromptTurns !== normalizedCurrentPromptTurns ||
      normalizedAdvancedConfig !== normalizedCurrentAdvancedConfig ||
      (editForm.isNegativeTest ?? false) !==
        (currentTestCase.isNegativeTest ?? false)
    );
  }, [editForm, currentAdvancedConfig, currentPromptTurns, currentTestCase]);

  const arePromptTurnsValid = useMemo(() => {
    if (!editForm) return true;
    return validatePromptTurns(editForm.promptTurns, isEffectivelyNegative);
  }, [editForm, isEffectivelyNegative]);

  const updatePromptTurn = (
    index: number,
    updater: (turn: PromptTurn) => PromptTurn,
  ) => {
    setEditForm((current) => {
      if (!current) return current;
      const nextTurns = current.promptTurns.map((turn, turnIndex) =>
        turnIndex === index ? updater(turn) : turn,
      );
      return { ...current, promptTurns: nextTurns };
    });
  };

  const movePromptTurn = (index: number, direction: -1 | 1) => {
    setEditForm((current) => {
      if (!current) return current;
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.promptTurns.length) {
        return current;
      }
      const nextTurns = [...current.promptTurns];
      const [turn] = nextTurns.splice(index, 1);
      nextTurns.splice(targetIndex, 0, turn!);
      return { ...current, promptTurns: nextTurns };
    });
  };

  const addPromptTurn = () => {
    setEditForm((current) => {
      if (!current) return current;
      return {
        ...current,
        promptTurns: [
          ...current.promptTurns,
          createEmptyPromptTurn(current.promptTurns.length),
        ],
      };
    });
  };

  const removePromptTurn = (index: number) => {
    setEditForm((current) => {
      if (!current || current.promptTurns.length <= 1) {
        return current;
      }
      return {
        ...current,
        promptTurns: current.promptTurns.filter(
          (_turn, turnIndex) => turnIndex !== index,
        ),
      };
    });
  };

  const updateAdvancedConfig = (patch: Record<string, unknown>) => {
    setEditForm((current) => {
      if (!current) return current;
      return {
        ...current,
        advancedConfig: normalizeAdvancedConfig({
          ...(current.advancedConfig ?? {}),
          ...patch,
        }),
      };
    });
  };

  const buildSavePayload = (form: TestTemplate) => {
    const normalizedPromptTurns = isEffectivelyNegative
      ? form.promptTurns.map((turn) => ({
          ...turn,
          expectedToolCalls: [],
        }))
      : form.promptTurns;
    const legacy = deriveLegacyPromptFields(normalizedPromptTurns);

    return {
      title: form.title,
      runs: form.runs,
      query: legacy.query,
      expectedToolCalls: isEffectivelyNegative ? [] : legacy.expectedToolCalls,
      expectedOutput: legacy.expectedOutput,
      promptTurns: normalizedPromptTurns,
      isNegativeTest: isEffectivelyNegative,
      advancedConfig: normalizeAdvancedConfig(form.advancedConfig),
    };
  };

  const handleSave = async () => {
    if (!editForm || !currentTestCase) return;

    if (!validatePromptTurns(editForm.promptTurns, isEffectivelyNegative)) {
      toast.error(
        "Each step needs a prompt, and positive tests need at least one asserted tool call.",
      );
      return;
    }

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        ...buildSavePayload(editForm),
        scenario: currentTestCase.scenario,
      });
      toast.success("Changes saved");
      setOptimisticNegative(null);
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save changes"));
      throw error;
    }
  };

  const handleRun = async () => {
    if (!selectedModel || !currentTestCase || !suite || !editForm) return;

    if (!validatePromptTurns(editForm.promptTurns, isEffectivelyNegative)) {
      toast.error(
        "Each step needs a prompt, and positive tests need at least one asserted tool call.",
      );
      return;
    }

    setCurrentQuickRunResult(null);
    setIsRunning(true);

    const savePayload = buildSavePayload(editForm);

    try {
      const preparedRun = await prepareSingleTestCaseRun({
        workspaceId,
        suite,
        testCase: currentTestCase,
        selectedModel,
        getAccessToken,
        getToken,
        hasToken,
        testCaseOverrides: {
          query: savePayload.query,
          expectedToolCalls: savePayload.expectedToolCalls,
          runs: savePayload.runs,
          expectedOutput: savePayload.expectedOutput,
          promptTurns: savePayload.promptTurns,
          advancedConfig: savePayload.advancedConfig,
        },
      });

      posthog.capture("eval_test_case_run_started", {
        location: "test_template_editor",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: suiteId,
        test_case_id: currentTestCase._id,
        model: preparedRun.modelValue,
      });

      const data = await runEvalTestCase(preparedRun.request);

      if (data.iteration) {
        setCurrentQuickRunResult(data.iteration);

        const iteration = data.iteration;
        const startedAt = iteration.startedAt ?? iteration.createdAt;
        const completedAt = iteration.updatedAt ?? iteration.createdAt;
        const durationMs =
          startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : 0;

        posthog.capture("eval_test_case_run_completed", {
          location: "test_template_editor",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          test_case_id: currentTestCase._id,
          model: preparedRun.modelValue,
          result: iteration.result || "unknown",
          duration_ms: durationMs,
        });
      }

      toast.success("Test completed successfully!");
    } catch (error) {
      console.error("Failed to run test case:", error);
      toast.error(getBillingErrorMessage(error, "Failed to run test case"));
    } finally {
      setIsRunning(false);
    }
  };

  const handleClearResult = async () => {
    if (!currentTestCase) return;

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        lastMessageRun: null,
      });
      setCurrentQuickRunResult(null);
      toast.success("Result cleared");
    } catch (error) {
      console.error("Failed to clear result:", error);
      toast.error(getBillingErrorMessage(error, "Failed to clear result"));
    }
  };

  const handleToggleNegative = async () => {
    if (!currentTestCase) return;

    const newValue = !isEffectivelyNegative;

    if (!newValue) {
      setOptimisticNegative(false);
      setEditForm((current) =>
        current ? { ...current, isNegativeTest: false } : current,
      );
      return;
    }

    const nextPromptTurns = (editForm?.promptTurns ?? currentPromptTurns).map(
      (turn) => ({
        ...turn,
        expectedToolCalls: [],
      }),
    );

    setOptimisticNegative(true);
    setEditForm((current) =>
      current
        ? {
            ...current,
            isNegativeTest: true,
            promptTurns: nextPromptTurns,
          }
        : current,
    );

    try {
      const legacy = deriveLegacyPromptFields(nextPromptTurns);
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        isNegativeTest: true,
        query: legacy.query,
        expectedToolCalls: [],
        expectedOutput: legacy.expectedOutput,
        promptTurns: nextPromptTurns,
      });
      setOptimisticNegative(null);
    } catch (error) {
      console.error("Failed to toggle negative test:", error);
      toast.error(getBillingErrorMessage(error, "Failed to update test type"));
      setOptimisticNegative(null);
    }
  };

  const modelOptions = useMemo(() => {
    return buildTestCaseModelOptions(availableModels, currentTestCase);
  }, [availableModels, currentTestCase]);

  useEffect(() => {
    const nextSelectedModel = resolveSelectedTestCaseModelValue({
      testCaseId: currentTestCase?._id ?? selectedTestCaseId,
      testCase: currentTestCase,
      modelOptions,
    });

    setSelectedModel(nextSelectedModel ?? "");
  }, [currentTestCase, modelOptions, selectedTestCaseId]);

  useEffect(() => {
    setPersistedTestCaseModelValue(selectedTestCaseId, selectedModel || null);
  }, [selectedModel, selectedTestCaseId]);

  if (!currentTestCase) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">Loading test case...</p>
      </div>
    );
  }

  const advancedConfig = editForm?.advancedConfig ?? {};
  const extraAdvancedKeys = Object.keys(advancedConfig).filter(
    (key) => !["system", "temperature", "toolChoice"].includes(key),
  );

  return (
    <ResizablePanelGroup direction="vertical" className="h-full">
      <ResizablePanel defaultSize={40} minSize={20}>
        <div className="h-full overflow-auto">
          <div className="p-2 space-y-3">
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
                      checked={isEffectivelyNegative}
                      onCheckedChange={handleToggleNegative}
                      className="scale-75 data-[state=checked]:bg-orange-500"
                    />
                    <span
                      className={`text-[10px] ${isEffectivelyNegative ? "text-orange-500" : "text-muted-foreground"}`}
                    >
                      NEG
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {isEffectivelyNegative
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
                      modelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>

                {hasUnsavedChanges && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          onClick={handleSave}
                          disabled={isRunning || !arePromptTurnsValid}
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
                      {!arePromptTurnsValid
                        ? "Each step needs a prompt, and positive tests need at least one asserted tool call."
                        : "Save changes to this test case"}
                    </TooltipContent>
                  </Tooltip>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        onClick={handleRun}
                        disabled={
                          !selectedModel ||
                          isRunning ||
                          !canRun ||
                          !arePromptTurnsValid
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
                        : !arePromptTurnsValid
                          ? "Each step needs a prompt, and positive tests need at least one asserted tool call."
                          : "Run this test"}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {editForm ? (
              <>
                <div className="px-1 pt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-xs text-muted-foreground font-medium">
                        Steps
                      </Label>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        One case row equals one multi-turn conversation.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={addPromptTurn}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      Add step
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {editForm.promptTurns.map((turn, index) => (
                      <div
                        key={turn.id}
                        className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                              {index + 1}
                            </div>
                            <div>
                              <div className="text-sm font-medium">
                                Step {index + 1}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {turn.expectedToolCalls.length > 0
                                  ? `${turn.expectedToolCalls.length} asserted tool call${turn.expectedToolCalls.length === 1 ? "" : "s"}`
                                  : isEffectivelyNegative
                                    ? "Negative step"
                                    : "No tool assertion on this step"}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              disabled={index === 0}
                              onClick={() => movePromptTurn(index, -1)}
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              disabled={index === editForm.promptTurns.length - 1}
                              onClick={() => movePromptTurn(index, 1)}
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground"
                              disabled={editForm.promptTurns.length <= 1}
                              onClick={() => removePromptTurn(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>

                        <div>
                          <Label className="text-xs text-muted-foreground font-medium">
                            User Prompt
                          </Label>
                          <Textarea
                            value={turn.prompt}
                            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                              updatePromptTurn(index, (currentTurn) => ({
                                ...currentTurn,
                                prompt: e.target.value,
                              }))
                            }
                            rows={3}
                            placeholder={`Enter the prompt for step ${index + 1}...`}
                            className="mt-1.5 font-mono text-sm resize-none border-0 bg-muted/30 focus-visible:bg-muted/50 transition-colors px-3 py-2.5"
                          />
                        </div>

                        {!isEffectivelyNegative ? (
                          <div>
                            <Label className="text-xs text-muted-foreground font-medium">
                              Expected Tools
                            </Label>
                            <p className="text-[10px] text-muted-foreground mb-1.5">
                              Leave empty to make this step informational only.
                            </p>
                            <ExpectedToolsEditor
                              toolCalls={turn.expectedToolCalls}
                              onChange={(toolCalls) =>
                                updatePromptTurn(index, (currentTurn) => ({
                                  ...currentTurn,
                                  expectedToolCalls: toolCalls,
                                }))
                              }
                              availableTools={availableTools}
                            />
                          </div>
                        ) : (
                          <div className="rounded-md border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-[11px] text-muted-foreground">
                            Negative cases assert that no tools are called across
                            all steps.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="px-1 pt-2 space-y-3">
                  <div>
                    <Label className="text-xs text-muted-foreground font-medium">
                      Advanced
                    </Label>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      These settings are saved with the case and reused by SDK
                      export paths.
                    </p>
                  </div>

                  <div>
                    <Label className="text-[11px] text-muted-foreground">
                      System Prompt
                    </Label>
                    <Textarea
                      value={
                        typeof advancedConfig.system === "string"
                          ? advancedConfig.system
                          : ""
                      }
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                        updateAdvancedConfig({ system: e.target.value })
                      }
                      rows={2}
                      placeholder="Optional system prompt"
                      className="mt-1.5 text-sm resize-none border-0 bg-muted/30 focus-visible:bg-muted/50 transition-colors px-3 py-2"
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-[11px] text-muted-foreground">
                        Temperature
                      </Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={
                          typeof advancedConfig.temperature === "number"
                            ? String(advancedConfig.temperature)
                            : ""
                        }
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          updateAdvancedConfig({
                            temperature:
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                          })
                        }
                        placeholder="e.g. 0.2"
                        className="mt-1.5"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">
                        Tool Choice
                      </Label>
                      <ToolChoicePicker
                        value={advancedConfig.toolChoice}
                        availableTools={availableTools}
                        onChange={(toolChoice) =>
                          updateAdvancedConfig({ toolChoice })
                        }
                      />
                      <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                        Browse the connected tools, inspect their parameter
                        schema, and optionally force a single tool or mode.
                      </p>
                    </div>
                  </div>

                  {extraAdvancedKeys.length > 0 ? (
                    <div className="text-[10px] text-muted-foreground">
                      Preserving {extraAdvancedKeys.length} additional advanced
                      setting{extraAdvancedKeys.length === 1 ? "" : "s"} on save.
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground">
                Loading...
              </div>
            )}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={60} minSize={20} maxSize={80}>
        <TestResultsPanel
          iteration={currentQuickRunResult}
          testCase={currentTestCase}
          loading={isRunning}
          onClear={handleClearResult}
          serverNames={(suite?.environment?.servers || []).filter((name: string) =>
            connectedServerNames.has(name),
          )}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
