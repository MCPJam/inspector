import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import posthog from "posthog-js";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { listEvalTools, runEvalTestCase } from "@/lib/apis/evals-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { ToolChoicePicker } from "./tool-choice-picker";
import { EvalTraceSurface } from "./eval-trace-surface";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { ModelDefinition } from "@/shared/types";
import {
  buildTestCaseModelOptions,
  getPersistedTestCaseModelValue,
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
import { normalizeToolChoice } from "@/shared/tool-choice";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import {
  buildHistoricalCompareRunRecords,
  buildCompareRunRecord,
  createCompareSessionId,
  mergeAdvancedConfigWithOverride,
  resolveIterationModelValue,
  resolveInitialCompareModelValues,
  resolveModelOptionLabel,
} from "./compare-playground-helpers";
import type {
  CompareModelOverride,
  CompareRunRecord,
  EditorMode,
  EvalIteration,
  RunColumnTab,
} from "./types";
import type { EvalExportDraftInput } from "@/lib/evals/eval-export";

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
  onBackToList?: () => void;
  onOpenLastRun?: (iteration: EvalIteration) => void;
  onExportDraft?: (draft: EvalExportDraftInput) => void;
}

type RunArtifactMode = "output" | "raw";

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

function formatPromptTurnSummary(
  turn: PromptTurn,
  isNegativeTest: boolean,
): string {
  if (isNegativeTest) {
    return "Negative step";
  }
  if (turn.expectedToolCalls.length > 0) {
    return `${turn.expectedToolCalls.length} asserted tool call${
      turn.expectedToolCalls.length === 1 ? "" : "s"
    }`;
  }
  return "Informational only";
}

function formatPromptPreview(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "Empty prompt";
  }
  return trimmed.length > 88 ? `${trimmed.slice(0, 88)}…` : trimmed;
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
  connectedServerNames,
  workspaceId,
  availableModels,
  onBackToList,
  onOpenLastRun,
  onExportDraft,
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("config");
  const [availableTools, setAvailableTools] = useState<
    Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId?: string;
    }>
  >([]);
  const [selectedModelValues, setSelectedModelValues] = useState<string[]>([]);
  const [compareRunRecords, setCompareRunRecords] = useState<
    Record<string, CompareRunRecord>
  >({});
  const [runColumnTabByModel, setRunColumnTabByModel] = useState<
    Record<string, RunColumnTab>
  >({});
  const [mobileVisibleModelValue, setMobileVisibleModelValue] = useState<
    string | null
  >(null);
  const [modelOverrides, setModelOverrides] = useState<
    Record<string, CompareModelOverride>
  >({});
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [showModelOverrides, setShowModelOverrides] = useState(false);
  const [expandedPromptTurnIds, setExpandedPromptTurnIds] = useState<string[]>(
    [],
  );
  const [isRunningCompare, setIsRunningCompare] = useState(false);
  const [addModelSelectKey, setAddModelSelectKey] = useState(0);
  const [artifactDialog, setArtifactDialog] = useState<{
    modelValue: string;
    mode: RunArtifactMode;
  } | null>(null);
  const activeCompareRequestRef = useRef(0);
  const initializedSelectionCaseRef = useRef<string | null>(null);

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

  const lastSavedIteration = useQuery(
    "testSuites:getTestIteration" as any,
    currentTestCase?.lastMessageRun
      ? { iterationId: currentTestCase.lastMessageRun }
      : "skip",
  ) as EvalIteration | undefined;
  const recentIterations = useQuery(
    "testSuites:listTestIterations" as any,
    currentTestCase?._id
      ? ({ testCaseId: currentTestCase._id } as any)
      : "skip",
  ) as EvalIteration[] | undefined;

  const suite = useQuery("testSuites:getTestSuite" as any, {
    suiteId,
  }) as any;

  useEffect(() => {
    setEditorMode("config");
    setCompareRunRecords({});
    setRunColumnTabByModel({});
    setMobileVisibleModelValue(null);
    setModelOverrides({});
    setShowAdvancedConfig(false);
    setShowModelOverrides(false);
    setExpandedPromptTurnIds([]);
    setArtifactDialog(null);
    setAddModelSelectKey(0);
    initializedSelectionCaseRef.current = null;
  }, [selectedTestCaseId]);

  useEffect(() => {
    if (!currentTestCase) {
      return;
    }

    const promptTurns = resolvePromptTurns(currentTestCase);
    setEditForm({
      title: currentTestCase.title,
      runs: currentTestCase.runs,
      isNegativeTest: currentTestCase.isNegativeTest,
      promptTurns,
      advancedConfig: normalizeAdvancedConfig(currentTestCase.advancedConfig),
    });
    setExpandedPromptTurnIds(promptTurns[0] ? [promptTurns[0].id] : []);
  }, [currentTestCase?._id]);

  const missingServers = useMemo(() => {
    if (!suite) return [];
    const suiteServers = suite.environment?.servers || [];
    return suiteServers.filter(
      (server: string) => !connectedServerNames.has(server),
    );
  }, [suite, connectedServerNames]);

  const canRun = missingServers.length === 0;

  useEffect(() => {
    let cancelled = false;

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
        if (!cancelled) {
          setAvailableTools(data.tools || []);
        }
      } catch (error) {
        console.error("Failed to fetch tools:", error);
        if (!cancelled) {
          setAvailableTools([]);
        }
      }
    }

    void fetchTools();

    return () => {
      cancelled = true;
    };
  }, [suite, workspaceId]);

  const handleTitleClick = () => {
    setIsEditingTitle(true);
  };

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleTitleBlur();
    } else if (event.key === "Escape") {
      if (editForm && currentTestCase) {
        setEditForm({ ...editForm, title: currentTestCase.title });
      }
      setIsEditingTitle(false);
    }
  };

  const isEffectivelyNegative =
    editForm?.isNegativeTest ?? currentTestCase?.isNegativeTest ?? false;

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
    return validatePromptTurns(editForm.promptTurns, editForm.isNegativeTest);
  }, [editForm]);

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
      const nextTurn = createEmptyPromptTurn(current.promptTurns.length);
      setExpandedPromptTurnIds([nextTurn.id]);
      return {
        ...current,
        promptTurns: [...current.promptTurns, nextTurn],
      };
    });
  };

  const removePromptTurn = (index: number) => {
    setEditForm((current) => {
      if (!current || current.promptTurns.length <= 1) {
        return current;
      }

      const removedTurnId = current.promptTurns[index]?.id;
      const nextTurns = current.promptTurns.filter(
        (_turn, turnIndex) => turnIndex !== index,
      );
      setExpandedPromptTurnIds((previous) => {
        const nextExpanded = previous.filter((id) => id !== removedTurnId);
        return nextExpanded.length > 0
          ? nextExpanded
          : nextTurns[0]
            ? [nextTurns[0].id]
            : [];
      });

      return {
        ...current,
        promptTurns: nextTurns,
      };
    });
  };

  const togglePromptTurnExpanded = (turnId: string) => {
    setExpandedPromptTurnIds((current) =>
      current.includes(turnId) ? [] : [turnId],
    );
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
    const isNegativeTest = form.isNegativeTest ?? false;
    const normalizedPromptTurns = isNegativeTest
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
      expectedToolCalls: isNegativeTest ? [] : legacy.expectedToolCalls,
      expectedOutput: legacy.expectedOutput,
      promptTurns: normalizedPromptTurns,
      isNegativeTest,
      advancedConfig: normalizeAdvancedConfig(form.advancedConfig),
    };
  };

  const handleExport = () => {
    if (!editForm || !currentTestCase || !onExportDraft) {
      return;
    }

    const savePayload = buildSavePayload(editForm);
    onExportDraft({
      testCaseId: currentTestCase._id,
      title: savePayload.title,
      query: savePayload.query,
      runs: savePayload.runs,
      expectedToolCalls: savePayload.expectedToolCalls,
      expectedOutput: savePayload.expectedOutput,
      promptTurns: savePayload.promptTurns,
      isNegativeTest: savePayload.isNegativeTest,
      advancedConfig: savePayload.advancedConfig,
      scenario: currentTestCase.scenario,
    });
  };

  const handleSave = async () => {
    if (!editForm || !currentTestCase) return;

    if (!validatePromptTurns(editForm.promptTurns, editForm.isNegativeTest)) {
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
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save changes"));
      throw error;
    }
  };

  const modelOptions = useMemo(() => {
    return buildTestCaseModelOptions(availableModels, currentTestCase);
  }, [availableModels, currentTestCase]);

  const modelLabelByValue = useMemo(
    () =>
      Object.fromEntries(
        modelOptions.map((option) => [option.value, option.label] as const),
      ),
    [modelOptions],
  );

  useEffect(() => {
    if (!currentTestCase?._id) {
      return;
    }
    if (initializedSelectionCaseRef.current === currentTestCase._id) {
      return;
    }

    const preferredModelValue = resolveSelectedTestCaseModelValue({
      testCaseId: currentTestCase._id ?? selectedTestCaseId,
      testCase: currentTestCase,
      modelOptions,
    });
    const initialSelectedModels = resolveInitialCompareModelValues({
      testCase: currentTestCase,
      modelOptions,
      preferredModelValue:
        preferredModelValue ??
        getPersistedTestCaseModelValue(currentTestCase._id),
    });

    initializedSelectionCaseRef.current = currentTestCase._id;
    setSelectedModelValues(initialSelectedModels);
  }, [currentTestCase, modelOptions, selectedTestCaseId]);

  useEffect(() => {
    if (!currentTestCase || !recentIterations || selectedModelValues.length === 0) {
      return;
    }

    setCompareRunRecords((current) =>
      buildHistoricalCompareRunRecords({
        selectedModelValues,
        modelLabelByValue,
        iterations: recentIterations,
        testCase: currentTestCase,
        existingRecords: current,
      }),
    );
  }, [
    currentTestCase,
    modelLabelByValue,
    recentIterations,
    selectedModelValues,
  ]);

  useEffect(() => {
    setPersistedTestCaseModelValue(
      selectedTestCaseId,
      selectedModelValues[0] ?? null,
    );
  }, [selectedModelValues, selectedTestCaseId]);

  useEffect(() => {
    setMobileVisibleModelValue((current) =>
      current && selectedModelValues.includes(current)
        ? current
        : selectedModelValues[0] ?? null,
    );
  }, [selectedModelValues]);

  const addableModelOptions = useMemo(
    () =>
      modelOptions.filter((option) => !selectedModelValues.includes(option.value)),
    [modelOptions, selectedModelValues],
  );

  const selectedCompareRecords = useMemo(
    () =>
      selectedModelValues.map((modelValue) => {
        const existingRecord = compareRunRecords[modelValue];
        if (existingRecord) {
          return existingRecord;
        }

        return buildCompareRunRecord({
          modelValue,
          modelLabel: resolveModelOptionLabel(modelValue, modelLabelByValue),
          iteration: null,
        });
      }),
    [compareRunRecords, modelLabelByValue, selectedModelValues],
  );

  const hasRunViewContent = selectedCompareRecords.some(
    (record) =>
      record.iteration != null ||
      record.status === "running" ||
      Boolean(record.error),
  );

  const openRunView = (source: "run_compare" | "config_toggle") => {
    setEditorMode("run");
    setMobileVisibleModelValue((current) =>
      current && selectedModelValues.includes(current)
        ? current
        : selectedModelValues[0] ?? null,
    );
    posthog.capture("compare_run_view_opened", {
      location: "test_template_editor",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      suite_id: suiteId,
      test_case_id: currentTestCase?._id ?? null,
      source,
      models: selectedModelValues,
    });
  };

  const handleAddModel = (modelValue: string) => {
    setSelectedModelValues((previous) => {
      if (previous.includes(modelValue)) {
        return previous;
      }
      return [...previous, modelValue].slice(0, 3);
    });
    setAddModelSelectKey((previous) => previous + 1);
  };

  const handleRemoveModel = (modelValue: string) => {
    setSelectedModelValues((previous) =>
      previous.filter((value) => value !== modelValue),
    );
  };

  const updateModelOverride = (
    modelValue: string,
    patch: Partial<CompareModelOverride>,
  ) => {
    setModelOverrides((previous) => ({
      ...previous,
      [modelValue]: {
        ...(previous[modelValue] ?? {}),
        ...patch,
      },
    }));
  };

  const handleRunCompare = async (modelValuesOverride?: string[]) => {
    if (!currentTestCase || !suite || !editForm) {
      return;
    }

    const runModelValues = (modelValuesOverride ?? selectedModelValues).filter(
      Boolean,
    );
    if (runModelValues.length === 0) {
      toast.error("Select at least one model to run.");
      return;
    }

    if (!validatePromptTurns(editForm.promptTurns, editForm.isNegativeTest)) {
      toast.error(
        "Each step needs a prompt, and positive tests need at least one asserted tool call.",
      );
      return;
    }

    const savePayload = buildSavePayload(editForm);
    const requestId = activeCompareRequestRef.current + 1;
    const compareRunId = createCompareSessionId();
    activeCompareRequestRef.current = requestId;

    let preparedRuns: Array<{
      modelValue: string;
      modelLabel: string;
      request: Awaited<ReturnType<typeof prepareSingleTestCaseRun>>;
    }> = [];

    try {
      preparedRuns = await Promise.all(
        runModelValues.map(async (modelValue) => {
          const modelLabel = resolveModelOptionLabel(modelValue, modelLabelByValue);
          const advancedConfig = mergeAdvancedConfigWithOverride({
            baseAdvancedConfig: savePayload.advancedConfig,
            override: modelOverrides[modelValue],
          });

          const preparedRun = await prepareSingleTestCaseRun({
            workspaceId,
            suite,
            testCase: currentTestCase,
            selectedModel: modelValue,
            getAccessToken,
            getToken,
            hasToken,
            testCaseOverrides: {
              query: savePayload.query,
              expectedToolCalls: savePayload.expectedToolCalls,
              runs: savePayload.runs,
              expectedOutput: savePayload.expectedOutput,
              promptTurns: savePayload.promptTurns,
              advancedConfig,
            },
          });

          return {
            modelValue,
            modelLabel,
            request: preparedRun,
          };
        }),
      );
    } catch (error) {
      console.error("Failed to prepare compare run:", error);
      toast.error(getBillingErrorMessage(error, "Failed to prepare compare run"));
      return;
    }

    setIsRunningCompare(true);
    setRunColumnTabByModel((previous) => ({
      ...previous,
      ...Object.fromEntries(
        runModelValues.map((modelValue) => [modelValue, "chat" as RunColumnTab]),
      ),
    }));
    setCompareRunRecords((previous) => {
      const next = { ...previous };
      const startedAt = Date.now();
      for (const { modelValue, modelLabel } of preparedRuns) {
        next[modelValue] = {
          ...buildCompareRunRecord({
            modelValue,
            modelLabel,
            iteration: null,
            startedAt,
          }),
          status: "running",
          startedAt,
          completedAt: null,
          error: null,
        };
      }
      return next;
    });
    openRunView("run_compare");

    posthog.capture("compare_run_started", {
      location: "test_template_editor",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      suite_id: suiteId,
      test_case_id: currentTestCase._id,
      compare_run_id: compareRunId,
      model_count: preparedRuns.length,
      models: preparedRuns.map((run) => run.modelValue),
    });

    const completedRecords = await Promise.all(
      preparedRuns.map(async ({ modelValue, modelLabel, request }) => {
        try {
          const data = await runEvalTestCase({
            ...request.request,
            skipLastMessageRunUpdate: true,
          });
          const record = buildCompareRunRecord({
            modelValue,
            modelLabel,
            iteration: data.iteration ?? null,
            completedAt: Date.now(),
          });

          if (activeCompareRequestRef.current === requestId) {
            setCompareRunRecords((previous) => ({
              ...previous,
              [modelValue]: record,
            }));
          }

          posthog.capture("compare_model_completed", {
            location: "test_template_editor",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            test_case_id: currentTestCase._id,
            compare_run_id: compareRunId,
            model: modelValue,
            result: record.result ?? "unknown",
            duration_ms: record.metrics.durationMs ?? null,
            tool_call_count: record.metrics.toolCallCount,
            mismatch_count: record.metrics.mismatchCount,
          });

          return record;
        } catch (error) {
          const message = getBillingErrorMessage(error, "Failed to run model");
          const failedRecord: CompareRunRecord = {
            ...buildCompareRunRecord({
              modelValue,
              modelLabel,
              iteration: null,
              error: message,
              completedAt: Date.now(),
            }),
            status: "failed",
            error: message,
          };

          if (activeCompareRequestRef.current === requestId) {
            setCompareRunRecords((previous) => ({
              ...previous,
              [modelValue]: failedRecord,
            }));
          }

          posthog.capture("compare_model_completed", {
            location: "test_template_editor",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            test_case_id: currentTestCase._id,
            compare_run_id: compareRunId,
            model: modelValue,
            result: "failed",
            error: message,
          });

          return failedRecord;
        }
      }),
    );

    if (activeCompareRequestRef.current !== requestId) {
      return;
    }

    setIsRunningCompare(false);

    const successfulCount = completedRecords.filter(
      (record) => record.iteration != null,
    ).length;
    if (successfulCount === completedRecords.length) {
      toast.success(
        `Compare run finished across ${completedRecords.length} model${
          completedRecords.length === 1 ? "" : "s"
        }.`,
      );
    } else if (successfulCount > 0) {
      toast.error(
        `${successfulCount}/${completedRecords.length} model${
          completedRecords.length === 1 ? "" : "s"
        } completed successfully.`,
      );
    } else {
      toast.error("Compare run failed for all selected models.");
    }
  };

  const handleSaveRun = async (
    record: CompareRunRecord | null | undefined,
  ) => {
    if (!currentTestCase || !record?.iteration) {
      return;
    }

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        lastMessageRun: record.iteration._id,
      });
      posthog.capture("compare_run_saved", {
        location: "test_template_editor",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: suiteId,
        test_case_id: currentTestCase._id,
        selected_run_id: record.iteration._id,
        model: record.modelValue,
      });
      toast.success("Saved this run as the latest test result.");
    } catch (error) {
      console.error("Failed to save run:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save test result"));
    }
  };

  const handleClearSavedResult = async () => {
    if (!currentTestCase?.lastMessageRun) {
      return;
    }

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        lastMessageRun: null,
      });
      toast.success("Cleared the saved latest result.");
    } catch (error) {
      console.error("Failed to clear latest result:", error);
      toast.error(getBillingErrorMessage(error, "Failed to clear latest result"));
    }
  };

  const handleNegativeToggle = (checked: boolean) => {
    setEditForm((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        isNegativeTest: checked,
        promptTurns: checked
          ? current.promptTurns.map((turn) => ({
              ...turn,
              expectedToolCalls: [],
            }))
          : current.promptTurns,
      };
    });
  };

  const handleRunColumnTabChange = (
    modelValue: string,
    tab: RunColumnTab,
  ) => {
    setRunColumnTabByModel((previous) => ({
      ...previous,
      [modelValue]: tab,
    }));
    posthog.capture("compare_run_tab_changed", {
      location: "test_template_editor",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      suite_id: suiteId,
      test_case_id: currentTestCase?._id ?? null,
      model: modelValue,
      tab,
    });
  };

  if (!currentTestCase) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading test case...</p>
      </div>
    );
  }

  const advancedConfig = editForm?.advancedConfig ?? {};
  const extraAdvancedKeys = Object.keys(advancedConfig).filter(
    (key) => !["system", "temperature", "toolChoice"].includes(key),
  );
  const connectedServerList = (suite?.environment?.servers || []).filter(
    (name: string) => connectedServerNames.has(name),
  );
  const promptValidityMessage =
    "Each step needs a prompt, and positive tests need at least one asserted tool call.";
  const runGridClassName =
    selectedCompareRecords.length <= 1
      ? "lg:grid-cols-1"
      : selectedCompareRecords.length === 2
        ? "lg:grid-cols-2"
        : "lg:grid-cols-3";
  const artifactRecord = artifactDialog
    ? compareRunRecords[artifactDialog.modelValue] ?? null
    : null;
  const latestAvailableIteration = recentIterations?.[0] ?? lastSavedIteration ?? null;
  const latestAvailableResult = latestAvailableIteration
    ? computeIterationResult(latestAvailableIteration)
    : null;
  const latestAvailableToneClass =
    latestAvailableResult === "passed"
      ? "text-emerald-700 dark:text-emerald-300"
      : latestAvailableResult === "failed"
        ? "text-rose-700 dark:text-rose-300"
        : latestAvailableResult === "cancelled"
          ? "text-amber-700 dark:text-amber-300"
          : "text-muted-foreground";
  const latestAvailableTimestamp =
    latestAvailableIteration?.updatedAt ??
    latestAvailableIteration?.startedAt ??
    latestAvailableIteration?.createdAt ??
    null;
  const latestAvailableModelValue = latestAvailableIteration
    ? resolveIterationModelValue(latestAvailableIteration, currentTestCase)
    : null;
  const latestAvailableModelLabel = latestAvailableModelValue
    ? resolveModelOptionLabel(latestAvailableModelValue, modelLabelByValue)
    : null;
  const latestAvailableIsSaved =
    Boolean(latestAvailableIteration?._id) &&
    latestAvailableIteration?._id === currentTestCase.lastMessageRun;
  const canOpenLastRun =
    Boolean(onOpenLastRun) &&
    Boolean(lastSavedIteration?.suiteRunId) &&
    Boolean(lastSavedIteration?._id);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {editorMode === "config" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5 sm:px-6 lg:py-6">
            <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  {onBackToList ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mb-3 -ml-2 h-8 px-2 text-xs text-muted-foreground"
                      onClick={onBackToList}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Back to cases
                    </Button>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {isEditingTitle ? (
                      <input
                        type="text"
                        value={editForm?.title || ""}
                        onChange={(event) =>
                          editForm &&
                          setEditForm({ ...editForm, title: event.target.value })
                        }
                        onBlur={handleTitleBlur}
                        onKeyDown={handleTitleKeyDown}
                        autoFocus
                        className="w-full min-w-0 bg-transparent px-0 py-0 text-xl font-semibold focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={handleTitleClick}
                      >
                        <h2 className="truncate text-xl font-semibold transition-opacity hover:opacity-80">
                          {editForm?.title || currentTestCase.title}
                        </h2>
                      </button>
                    )}
                    <div className="flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/5 px-3 py-1.5">
                      <Switch
                        checked={isEffectivelyNegative}
                        onCheckedChange={handleNegativeToggle}
                        className="data-[state=checked]:bg-orange-500"
                      />
                      <span className="text-xs font-medium text-muted-foreground">
                        Negative test
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                    Configure one case, then switch into a dedicated compare run view
                    with one column per model.
                  </p>
                  {!canRun ? (
                    <p className="mt-3 text-xs text-destructive">
                      Connect the following servers before running:{" "}
                      {missingServers.join(", ")}
                    </p>
                  ) : null}
                  {latestAvailableIteration ? (
                    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Latest run
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 font-medium",
                              latestAvailableToneClass,
                            )}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {latestAvailableResult === "passed"
                              ? "Passed"
                              : latestAvailableResult === "failed"
                                ? "Failed"
                                : latestAvailableResult === "cancelled"
                                  ? "Cancelled"
                                  : latestAvailableIteration
                                    ? "Running"
                                    : "Loading…"}
                          </span>
                          {latestAvailableTimestamp ? (
                            <span className="text-muted-foreground">
                              {formatRelativeTime(latestAvailableTimestamp)}
                            </span>
                          ) : null}
                          {latestAvailableModelLabel ? (
                            <span className="truncate text-muted-foreground">
                              {latestAvailableModelLabel}
                            </span>
                          ) : null}
                          <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                            {latestAvailableIsSaved ? "Saved" : "Unsaved"}
                          </span>
                        </div>
                        {!latestAvailableIsSaved && currentTestCase.lastMessageRun ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            The saved latest result is older than this run.
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {hasRunViewContent ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0"
                            onClick={() => openRunView("config_toggle")}
                          >
                            View results
                          </Button>
                        ) : canOpenLastRun ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0"
                            onClick={() =>
                              lastSavedIteration && onOpenLastRun?.(lastSavedIteration)
                            }
                          >
                            Open last run
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {onExportDraft ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleExport}
                      disabled={!editForm}
                    >
                      <Code2 className="mr-2 h-4 w-4" />
                      Export
                    </Button>
                  ) : null}
                  {hasUnsavedChanges ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleSave()}
                      disabled={!arePromptTurnsValid || isRunningCompare}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      Save case
                    </Button>
                  ) : null}
                  {hasRunViewContent ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => openRunView("config_toggle")}
                    >
                      View results
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    onClick={() => void handleRunCompare()}
                    disabled={
                      selectedModelValues.length === 0 ||
                      isRunningCompare ||
                      !canRun ||
                      !arePromptTurnsValid
                    }
                  >
                    {isRunningCompare ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Running…
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4 fill-current" />
                        Run compare
                      </>
                    )}
                  </Button>
                </div>
              </div>
              {!arePromptTurnsValid ? (
                <p className="mt-3 text-xs text-destructive">
                  {promptValidityMessage}
                </p>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Models
                  </Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Select up to three models to compare side by side.
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {selectedModelValues.length}/3
                </Badge>
              </div>

              <div className="mt-4 space-y-2">
                {selectedModelValues.length > 0 ? (
                  selectedModelValues.map((modelValue) => (
                    <div
                      key={modelValue}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {resolveModelOptionLabel(modelValue, modelLabelByValue)}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">
                          {modelValue}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={() => handleRemoveModel(modelValue)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
                    Add at least one model to enable compare runs.
                  </div>
                )}
              </div>

              <div className="mt-3">
                <Select
                  key={addModelSelectKey}
                  onValueChange={handleAddModel}
                  disabled={
                    addableModelOptions.length === 0 ||
                    selectedModelValues.length >= 3
                  }
                >
                  <SelectTrigger className="bg-background">
                    <SelectValue
                      placeholder={
                        selectedModelValues.length >= 3
                          ? "Maximum of 3 models selected"
                          : "Add another model"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {addableModelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Prompt Flow
                  </Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Keep the authoring surface compact. Expand only the step you need
                    to edit.
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addPromptTurn}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add step
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                {editForm?.promptTurns.map((turn, index) => {
                  const isExpanded = expandedPromptTurnIds.includes(turn.id);
                  return (
                    <div
                      key={turn.id}
                      className="rounded-xl border border-border/60 bg-background/60"
                    >
                      <div className="flex items-start gap-3 px-4 py-3">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-3 text-left"
                          onClick={() => togglePromptTurnExpanded(turn.id)}
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {index + 1}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                Step {index + 1}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {formatPromptTurnSummary(turn, isEffectivelyNegative)}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {formatPromptPreview(turn.prompt)}
                            </p>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
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
                            className="h-8 w-8 p-0"
                            disabled={editForm.promptTurns.length <= 1}
                            onClick={() => removePromptTurn(index)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => togglePromptTurnExpanded(turn.id)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="space-y-4 border-t border-border/50 px-4 py-4">
                          <div>
                            <Label className="text-xs font-medium text-muted-foreground">
                              User Prompt
                            </Label>
                            <Textarea
                              value={turn.prompt}
                              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                                updatePromptTurn(index, (currentTurn) => ({
                                  ...currentTurn,
                                  prompt: event.target.value,
                                }))
                              }
                              rows={4}
                              placeholder={`Enter the prompt for step ${index + 1}...`}
                              className="mt-1.5 resize-none bg-background font-mono text-sm"
                            />
                          </div>

                          {!isEffectivelyNegative ? (
                            <div>
                              <Label className="text-xs font-medium text-muted-foreground">
                                Expected Tools
                              </Label>
                              <p className="mb-1.5 text-[11px] text-muted-foreground">
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
                            <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-[11px] text-muted-foreground">
                              Negative cases assert that no tools are called across all
                              steps.
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => setShowAdvancedConfig((current) => !current)}
              >
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Advanced Config
                  </Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Shared settings first. Per-model overrides stay hidden unless
                    needed.
                  </p>
                </div>
                {showAdvancedConfig ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {showAdvancedConfig ? (
                <div className="mt-4 space-y-5 border-t border-border/50 pt-4">
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
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                        updateAdvancedConfig({ system: event.target.value })
                      }
                      rows={3}
                      placeholder="Optional system prompt"
                      className="mt-1.5 resize-none bg-background"
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
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
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateAdvancedConfig({
                            temperature:
                              event.target.value === ""
                                ? undefined
                                : Number(event.target.value),
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
                        onChange={(toolChoice) => updateAdvancedConfig({ toolChoice })}
                      />
                    </div>
                  </div>

                  {extraAdvancedKeys.length > 0 ? (
                    <div className="text-[11px] text-muted-foreground">
                      Preserving {extraAdvancedKeys.length} additional advanced
                      setting{extraAdvancedKeys.length === 1 ? "" : "s"} on save.
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-border/60 bg-background/60">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                      onClick={() => setShowModelOverrides((current) => !current)}
                    >
                      <div>
                        <div className="text-sm font-medium">Overrides</div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Use only when one model needs a different system prompt,
                          temperature, or provider flags.
                        </p>
                      </div>
                      {showModelOverrides ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>

                    {showModelOverrides ? (
                      <div className="space-y-4 border-t border-border/50 px-4 py-4">
                        {selectedModelValues.map((modelValue) => {
                          const override = modelOverrides[modelValue] ?? {};
                          return (
                            <div
                              key={`override-${modelValue}`}
                              className="rounded-xl border border-border/60 bg-background p-4"
                            >
                              <div className="text-sm font-medium">
                                {resolveModelOptionLabel(modelValue, modelLabelByValue)}
                              </div>
                              <div className="mt-4 space-y-4">
                                <div>
                                  <Label className="text-[11px] text-muted-foreground">
                                    System override
                                  </Label>
                                  <Textarea
                                    value={override.systemPrompt ?? ""}
                                    onChange={(event) =>
                                      updateModelOverride(modelValue, {
                                        systemPrompt: event.target.value,
                                      })
                                    }
                                    rows={3}
                                    placeholder="Optional model-specific system prompt"
                                    className="mt-1.5 resize-none bg-background"
                                  />
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                  <div>
                                    <Label className="text-[11px] text-muted-foreground">
                                      Temperature override
                                    </Label>
                                    <Input
                                      value={override.temperature ?? ""}
                                      onChange={(event) =>
                                        updateModelOverride(modelValue, {
                                          temperature: event.target.value,
                                        })
                                      }
                                      placeholder="e.g. 0.2"
                                      className="mt-1.5"
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[11px] text-muted-foreground">
                                      Provider flags JSON
                                    </Label>
                                    <Textarea
                                      value={override.providerFlagsJson ?? ""}
                                      onChange={(event) =>
                                        updateModelOverride(modelValue, {
                                          providerFlagsJson: event.target.value,
                                        })
                                      }
                                      rows={3}
                                      placeholder='{"reasoningEffort":"high"}'
                                      className="mt-1.5 resize-none bg-background font-mono text-xs"
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            {currentTestCase.lastMessageRun ? (
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={() => void handleClearSavedResult()}
                >
                  Clear saved latest result
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="border-b px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                {onBackToList ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mb-3 -ml-2 h-8 px-2 text-xs text-muted-foreground"
                    onClick={onBackToList}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to cases
                  </Button>
                ) : null}
                <div className="truncate text-xl font-semibold">
                  {editForm?.title || currentTestCase.title}
                </div>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  Each selected model gets its own run column with independent Chat,
                  Trace, and Tools tabs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditorMode("config")}
                >
                  Edit config
                </Button>
              </div>
            </div>

            {selectedCompareRecords.length > 1 ? (
              <div className="mt-4 flex gap-2 overflow-x-auto lg:hidden">
                {selectedCompareRecords.map((record) => (
                  <Button
                    key={`mobile-model-${record.modelValue}`}
                    type="button"
                    size="sm"
                    variant={
                      mobileVisibleModelValue === record.modelValue
                        ? "secondary"
                        : "outline"
                    }
                    className="shrink-0"
                    onClick={() => setMobileVisibleModelValue(record.modelValue)}
                  >
                    {record.modelLabel}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            {selectedCompareRecords.length === 0 ? (
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center">
                <div>
                  <div className="text-sm font-medium">No compare run yet</div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Go back to config, choose at least one model, and run compare.
                  </p>
                </div>
              </div>
            ) : (
              <div className={cn("grid gap-4", runGridClassName)}>
                {selectedCompareRecords.map((record) => {
                  const showOnMobile =
                    selectedCompareRecords.length <= 1 ||
                    mobileVisibleModelValue === record.modelValue;

                  return (
                    <div
                      key={record.modelValue}
                      className={cn(showOnMobile ? "block" : "hidden", "lg:block")}
                    >
                      <RunColumn
                        record={record}
                        testCase={currentTestCase}
                        serverNames={connectedServerList}
                        activeTab={runColumnTabByModel[record.modelValue] ?? "chat"}
                        isBusy={isRunningCompare}
                        onTabChange={(tab) =>
                          handleRunColumnTabChange(record.modelValue, tab)
                        }
                        onRetry={() => void handleRunCompare([record.modelValue])}
                        onSave={() => void handleSaveRun(record)}
                        onOpenArtifact={(mode) =>
                          setArtifactDialog({
                            modelValue: record.modelValue,
                            mode,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={artifactDialog != null}
        onOpenChange={(open) => {
          if (!open) {
            setArtifactDialog(null);
          }
        }}
      >
        <DialogContent className="flex h-[85vh] max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle>
              {artifactRecord?.modelLabel ?? "Run artifact"} ·{" "}
              {artifactDialog?.mode === "raw" ? "Raw payload" : "Output"}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <EvalTraceSurface
              iteration={artifactRecord?.iteration ?? null}
              testCase={currentTestCase}
              serverNames={connectedServerList}
              mode={artifactDialog?.mode ?? "output"}
              emptyMessage="No artifact is available for this run."
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunColumn({
  record,
  testCase,
  serverNames,
  activeTab,
  isBusy,
  onTabChange,
  onRetry,
  onSave,
  onOpenArtifact,
}: {
  record: CompareRunRecord;
  testCase: any;
  serverNames: string[];
  activeTab: RunColumnTab;
  isBusy: boolean;
  onTabChange: (tab: RunColumnTab) => void;
  onRetry: () => void;
  onSave: () => void;
  onOpenArtifact: (mode: RunArtifactMode) => void;
}) {
  const statusTone =
    record.status === "running"
      ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
      : record.status === "failed" || record.result === "failed"
        ? "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
        : record.result === "passed"
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-border/60 bg-background text-muted-foreground";
  const statusLabel =
    record.status === "running"
      ? "Running"
      : record.status === "failed"
        ? "Failed"
        : record.result === "passed"
          ? "Passed"
          : record.result === "failed"
            ? "Failed"
            : "Ready";
  const durationLabel =
    record.metrics.durationMs != null
      ? `${Math.round(record.metrics.durationMs / 100) / 10}s`
      : "—";
  const traceMode =
    activeTab === "chat" ? "chat" : activeTab === "trace" ? "timeline" : "tools";

  return (
    <div className="flex min-h-[620px] flex-col rounded-2xl border border-border/60 bg-card/40">
      <div className="border-b px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{record.modelLabel}</div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {record.modelValue}
            </div>
          </div>
          <Badge variant="outline" className={cn("shrink-0", statusTone)}>
            {statusLabel}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 text-[11px] text-muted-foreground">
          <div>
            <div className="text-sm font-semibold text-foreground">
              {durationLabel}
            </div>
            <div>Latency</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">
              {record.metrics.toolCallCount}
            </div>
            <div>Tool calls</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">
              {record.metrics.tokensUsed.toLocaleString()}
            </div>
            <div>Tokens</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {(["chat", "trace", "tools"] as RunColumnTab[]).map((tab) => (
              <Button
                key={`${record.modelValue}-${tab}`}
                type="button"
                size="sm"
                variant={activeTab === tab ? "secondary" : "outline"}
                className="h-8 px-3 text-xs capitalize"
                onClick={() => onTabChange(tab)}
              >
                {tab}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={onRetry}
              disabled={isBusy || record.status === "running"}
            >
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
            {record.iteration ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={onSave}
                disabled={isBusy}
              >
                Save run
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  disabled={!record.iteration}
                  aria-label="Open additional run artifacts"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onOpenArtifact("output")}>
                  Open output
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenArtifact("raw")}>
                  Open raw payload
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {record.metrics.mismatchCount != null &&
        record.metrics.mismatchCount > 0 ? (
          <div className="mt-3 text-[11px] text-muted-foreground">
            {record.metrics.mismatchCount} mismatch
            {record.metrics.mismatchCount === 1 ? "" : "es"} across expected tool
            calls.
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 p-4">
        {record.status === "running" && !record.iteration ? (
          <div className="flex h-full min-h-[320px] items-center justify-center rounded-xl border border-border/50 bg-muted/10">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Running {record.modelLabel}…</span>
            </div>
          </div>
        ) : record.status === "failed" && !record.iteration ? (
          <div className="flex h-full min-h-[320px] items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10">
            <div className="max-w-sm text-center">
              <div className="text-sm font-medium text-destructive">
                {record.modelLabel} failed
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {record.error || "No run data is available for this model."}
              </p>
            </div>
          </div>
        ) : record.iteration ? (
          <EvalTraceSurface
            iteration={record.iteration}
            testCase={testCase}
            serverNames={serverNames}
            mode={traceMode}
            emptyMessage={`No ${activeTab} data is available for this run.`}
          />
        ) : (
          <div className="flex h-full min-h-[320px] items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center">
            <div>
              <div className="text-sm font-medium">No run yet</div>
              <p className="mt-2 text-sm text-muted-foreground">
                Run compare to load this model’s chat, trace, and tool details.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
