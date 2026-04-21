import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import posthog from "posthog-js";
import {
  ArrowLeft,
  Code2,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  Save,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  listEvalTools,
  runEvalTestCase,
  streamEvalTestCase,
} from "@/lib/apis/evals-api";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { TestCasePromptFlow } from "./test-case-prompt-flow";
import { CompareRunChatSurface } from "./compare-run-chat-surface";
import { EvalTraceSurface } from "./eval-trace-surface";
import {
  ModelCompareCardHeader,
  type MultiModelCardSummary,
} from "@/components/chat-v2/model-compare-card-header";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { ModelDefinition } from "@/shared/types";
import {
  buildTestCaseModelOptions,
  getPersistedTestCaseModelValue,
  prepareSingleTestCaseRun,
  resolveSelectedTestCaseModelValue,
  setPersistedTestCaseModelValue,
  type TestCaseModelOption,
} from "./single-test-case-runner";
import {
  deriveLegacyPromptFields,
  flattenAssertedExpectedToolCalls,
  resolveIterationDisplayExpectedToolCalls,
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
} from "@/shared/prompt-turns";
import { normalizeToolChoice } from "@/shared/tool-choice";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "./pass-criteria";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import {
  buildHistoricalCompareRunRecords,
  buildComparePreviewTrace,
  buildCompareRunRecord,
  createCompareSessionId,
  mergeAdvancedConfigWithOverride,
  parseModelValue,
  resolveInitialCompareModelValues,
  resolveIterationModelValue,
  resolveLatestCompareRunId,
  resolveModelOptionLabel,
} from "./compare-playground-helpers";
import type {
  CompareRunRecord,
  EditorMode,
  EvalIteration,
  RunColumnTab,
} from "./types";
import type { EvalExportDraftInput } from "@/lib/evals/eval-export";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import {
  reduceEvalStreamEvent,
  initialEvalStreamState,
  mergeStreamingTrace,
} from "./eval-stream-reducer";
import { TraceViewer } from "./trace-viewer";
import { useEvalTraceToolContext } from "./use-eval-trace-tool-context";
import { useEvalTraceBlob } from "./use-eval-trace-blob";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
} from "./trace-viewer-adapter";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import { HostStylePillSelector } from "@/components/shared/HostStylePillSelector";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface TestTemplate {
  title: string;
  runs: number;
  scenario?: string;
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
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  /** Deep link: open compare run surface once iteration data is ready (same as View results). */
  openCompareFromRoute?: boolean;
  /** Deep link: exact iteration to anchor compare hydration to. */
  openCompareIterationId?: string | null;
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

/** When every step has no asserted tool calls, the case expects no tool usage (stored as isNegativeTest). */
function deriveIsNegativeTestFromPromptTurns(
  promptTurns: PromptTurn[],
): boolean {
  return promptTurns.every((turn) => turn.expectedToolCalls.length === 0);
}

function compactModelLabel(name: string): string {
  return name.replace(/\s*\(Free\)\s*$/i, "").trim() || name;
}

const validatePromptTurns = (promptTurns: PromptTurn[]): boolean => {
  if (!Array.isArray(promptTurns) || promptTurns.length === 0) {
    return false;
  }

  if (promptTurns.some((turn) => !turn.prompt.trim())) {
    return false;
  }

  const isNegativeTest = deriveIsNegativeTestFromPromptTurns(promptTurns);
  if (isNegativeTest) {
    return true;
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

/** Short message when Run/Save are blocked by prompt or expected-tool validation. */
export function getPromptTurnBlockReason(
  promptTurns: PromptTurn[],
): string | null {
  if (!Array.isArray(promptTurns) || promptTurns.length === 0) {
    return "Configure at least one prompt step.";
  }

  const emptySteps = promptTurns
    .map((turn, i) => (!turn.prompt.trim() ? i + 1 : null))
    .filter((n): n is number => n !== null);

  if (emptySteps.length > 0) {
    if (promptTurns.length === 1) {
      return "Enter a user prompt before run or save.";
    }
    return `Enter a user prompt for step(s) ${emptySteps.join(", ")}.`;
  }

  if (validatePromptTurns(promptTurns)) {
    return null;
  }

  return "Finish tool names and arguments, or remove incomplete expected tools.";
}

function isStepPromptEmpty(turn: PromptTurn | undefined): boolean {
  return !(turn?.prompt ?? "").trim();
}

function stepExpectedToolsNeedAttention(turn: PromptTurn | undefined): boolean {
  if (!turn) {
    return false;
  }
  return (
    turn.expectedToolCalls.length > 0 &&
    !validateExpectedToolCalls(turn.expectedToolCalls)
  );
}

/** Validation outline only (no fill) — destructive border hue. */
const evalValidationBorderClass =
  "border border-destructive/40 dark:border-destructive/50";

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

function readCompareRunIdFromIteration(
  iteration: Pick<EvalIteration, "metadata"> | null | undefined,
) {
  const compareRunId = iteration?.metadata?.compareRunId;
  return typeof compareRunId === "string" && compareRunId.trim().length > 0
    ? compareRunId
    : null;
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
  onContinueInChat,
  openCompareFromRoute = false,
  openCompareIterationId = null,
}: TestTemplateEditorProps) {
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(
    openCompareFromRoute ? "run" : "config",
  );
  const [availableTools, setAvailableTools] = useState<
    Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId?: string;
    }>
  >([]);
  const [selectedModelValues, setSelectedModelValues] = useState<string[]>([]);
  const [addModelMenuOpen, setAddModelMenuOpen] = useState(false);
  const [compareRunRecords, setCompareRunRecords] = useState<
    Record<string, CompareRunRecord>
  >({});
  const [routeCompareAnchorIterationId, setRouteCompareAnchorIterationId] =
    useState<string | null>(openCompareIterationId);
  const [activeCompareRunId, setActiveCompareRunId] = useState<string | null>(
    null,
  );
  const [runColumnTabByModel, setRunColumnTabByModel] = useState<
    Record<string, RunColumnTab>
  >({});
  const [mobileVisibleModelValue, setMobileVisibleModelValue] = useState<
    string | null
  >(null);
  const [expandedPromptTurnIds, setExpandedPromptTurnIds] = useState<string[]>(
    [],
  );
  const [isRunningCompare, setIsRunningCompare] = useState(false);
  /** Concurrent compare `handleRunCompare` calls; used only for global `isRunningCompare`. */
  const compareHandlesInFlightRef = useRef(0);
  /**
   * Per-model generation counter so completions from an older run for the same model
   * do not overwrite state after a newer retry was started (allows parallel runs on
   * different models).
   */
  const compareRequestGenByModelRef = useRef<Record<string, number>>({});
  /** Per-model AbortControllers for cancelling superseded streaming runs. */
  const compareAbortControllersRef = useRef<Record<string, AbortController>>(
    {},
  );
  /** True when the user clicked Stop for the current batch (suppresses failure toasts). */
  const compareRunUserStoppedRef = useRef(false);
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

  const routeCompareAnchorIteration = useQuery(
    "testSuites:getTestIteration" as any,
    routeCompareAnchorIterationId
      ? { iterationId: routeCompareAnchorIterationId }
      : "skip",
  ) as EvalIteration | null | undefined;
  const lastSavedIteration = useQuery(
    "testSuites:getTestIteration" as any,
    currentTestCase?.lastMessageRun
      ? { iterationId: currentTestCase.lastMessageRun }
      : "skip",
  ) as EvalIteration | undefined;
  const recentIterations = useQuery(
    "testSuites:listTestIterations" as any,
    currentTestCase?._id
      ? ({ testCaseId: currentTestCase._id, limit: 200 } as any)
      : "skip",
  ) as EvalIteration[] | undefined;

  const suite = useQuery("testSuites:getTestSuite" as any, {
    suiteId,
  }) as any;

  useEffect(() => {
    setEditorMode(openCompareFromRoute ? "run" : "config");
    setCompareRunRecords({});
    setActiveCompareRunId(null);
    setRunColumnTabByModel({});
    setMobileVisibleModelValue(null);
    setExpandedPromptTurnIds([]);
    initializedSelectionCaseRef.current = null;
    setAddModelMenuOpen(false);
  }, [openCompareFromRoute, selectedTestCaseId]);

  useEffect(() => {
    setRouteCompareAnchorIterationId(openCompareIterationId);
  }, [openCompareIterationId, selectedTestCaseId]);

  useEffect(() => {
    if (openCompareFromRoute) {
      setEditorMode("run");
    }
  }, [openCompareFromRoute, openCompareIterationId, selectedTestCaseId]);

  const clearCompareStreamingState = useCallback((modelValue: string) => {
    setCompareRunRecords((previous) => {
      const current = previous[modelValue];
      if (!current) return previous;
      const {
        streamingTrace: _streamingTrace,
        streamingDraftMessages: _streamingDraftMessages,
        streamingActualToolCalls: _streamingActualToolCalls,
        streamingMetrics: _streamingMetrics,
        ...rest
      } = current;
      return { ...previous, [modelValue]: rest };
    });
  }, []);

  useEffect(() => {
    if (!currentTestCase) {
      return;
    }

    const promptTurns = resolvePromptTurns(currentTestCase);
    setEditForm({
      title: currentTestCase.title,
      runs: currentTestCase.runs,
      scenario: currentTestCase.scenario ?? "",
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

    const normalizedScenario = (editForm.scenario ?? "").trim();
    const normalizedCurrentScenario = (currentTestCase.scenario ?? "").trim();

    const effectiveNegativeOnServer =
      deriveIsNegativeTestFromPromptTurns(currentPromptTurns);
    const serverNegativeFlagMismatch =
      (currentTestCase.isNegativeTest ?? false) !== effectiveNegativeOnServer;

    return (
      editForm.title !== currentTestCase.title ||
      editForm.runs !== currentTestCase.runs ||
      normalizedScenario !== normalizedCurrentScenario ||
      normalizedPromptTurns !== normalizedCurrentPromptTurns ||
      normalizedAdvancedConfig !== normalizedCurrentAdvancedConfig ||
      serverNegativeFlagMismatch
    );
  }, [editForm, currentAdvancedConfig, currentPromptTurns, currentTestCase]);

  const arePromptTurnsValid = useMemo(() => {
    if (!editForm) return true;
    return validatePromptTurns(editForm.promptTurns);
  }, [editForm]);

  const savePrimaryDisabled = !arePromptTurnsValid || isRunningCompare;

  const saveDisabledTooltip = useMemo(() => {
    if (!savePrimaryDisabled) {
      return null;
    }
    if (isRunningCompare) {
      return "Wait for the current run to finish before saving.";
    }
    if (!arePromptTurnsValid && editForm) {
      return getPromptTurnBlockReason(editForm.promptTurns);
    }
    return null;
  }, [savePrimaryDisabled, isRunningCompare, arePromptTurnsValid, editForm]);

  const runPrimaryDisabled =
    selectedModelValues.length === 0 ||
    isRunningCompare ||
    !canRun ||
    !arePromptTurnsValid;

  const runDisabledTooltip = useMemo(() => {
    if (!runPrimaryDisabled) {
      return null;
    }
    if (selectedModelValues.length === 0) {
      return "Select at least one model to run.";
    }
    if (!canRun) {
      return missingServers.length
        ? `Connect to: ${missingServers.join(", ")}`
        : "Connect to suite servers to run.";
    }
    if (isRunningCompare) {
      return null;
    }
    if (!arePromptTurnsValid && editForm) {
      return getPromptTurnBlockReason(editForm.promptTurns);
    }
    return null;
  }, [
    runPrimaryDisabled,
    selectedModelValues.length,
    canRun,
    missingServers,
    isRunningCompare,
    arePromptTurnsValid,
    editForm,
  ]);

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
      setExpandedPromptTurnIds((previous) => [...previous, nextTurn.id]);
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
      current.includes(turnId)
        ? current.filter((id) => id !== turnId)
        : [...current, turnId],
    );
  };

  const buildSavePayload = (form: TestTemplate) => {
    const isNegativeTest = deriveIsNegativeTestFromPromptTurns(
      form.promptTurns,
    );
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
      scenario: form.scenario?.trim() ? form.scenario.trim() : undefined,
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
      scenario: savePayload.scenario,
    });
  };

  const handleSave = async () => {
    if (!editForm || !currentTestCase) return;

    if (!validatePromptTurns(editForm.promptTurns)) {
      toast.error(
        getPromptTurnBlockReason(editForm.promptTurns) ??
          "Fix the test configuration before saving.",
      );
      return;
    }

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        ...buildSavePayload(editForm),
      });
      toast.success("Changes saved");
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save changes"));
      throw error;
    }
  };

  const persistSelectedCompareModels = async (modelValues: string[]) => {
    if (!currentTestCase) {
      return;
    }

    const nextModels = modelValues.map((modelValue) => {
      const { provider, model } = parseModelValue(modelValue);
      if (!provider || !model) {
        throw new Error(`Invalid model selection: ${modelValue}`);
      }
      return { provider, model };
    });

    const currentModels = currentTestCase.models ?? [];
    const modelsUnchanged =
      currentModels.length === nextModels.length &&
      currentModels.every(
        (model, index) =>
          model.provider === nextModels[index]?.provider &&
          model.model === nextModels[index]?.model,
      );

    if (modelsUnchanged) {
      return;
    }

    await updateTestCaseMutation({
      testCaseId: currentTestCase._id,
      models: nextModels,
    });
  };

  const latestHistoricalCompareRunId = useMemo(
    () => resolveLatestCompareRunId(recentIterations ?? []),
    [recentIterations],
  );
  const routeCompareAnchorModelValue = useMemo(
    () =>
      routeCompareAnchorIteration
        ? resolveIterationModelValue(
            routeCompareAnchorIteration,
            currentTestCase,
          )
        : null,
    [currentTestCase, routeCompareAnchorIteration],
  );
  const routeCompareAnchorRunId = useMemo(
    () => readCompareRunIdFromIteration(routeCompareAnchorIteration),
    [routeCompareAnchorIteration],
  );

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

  const modelOptionByValue = useMemo(
    () =>
      Object.fromEntries(
        modelOptions.map(
          (option) => [option.value, option] as [string, TestCaseModelOption],
        ),
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
    if (
      routeCompareAnchorIterationId &&
      routeCompareAnchorIteration === undefined
    ) {
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
    const routeAnchoredModels = routeCompareAnchorModelValue
      ? [
          routeCompareAnchorModelValue,
          ...initialSelectedModels.filter(
            (modelValue) => modelValue !== routeCompareAnchorModelValue,
          ),
        ].slice(0, 3)
      : initialSelectedModels;

    initializedSelectionCaseRef.current = currentTestCase._id;
    setSelectedModelValues(routeAnchoredModels);
  }, [
    currentTestCase,
    modelOptions,
    routeCompareAnchorIteration,
    routeCompareAnchorIterationId,
    routeCompareAnchorModelValue,
    selectedTestCaseId,
  ]);

  useEffect(() => {
    if (!routeCompareAnchorModelValue) {
      return;
    }

    setSelectedModelValues((current) => {
      const next = [
        routeCompareAnchorModelValue,
        ...current.filter(
          (modelValue) => modelValue !== routeCompareAnchorModelValue,
        ),
      ].slice(0, 3);

      return current.join("|") === next.join("|") ? current : next;
    });
  }, [routeCompareAnchorModelValue]);

  useEffect(() => {
    if (
      !currentTestCase ||
      !recentIterations ||
      selectedModelValues.length === 0 ||
      (routeCompareAnchorIterationId &&
        routeCompareAnchorIteration === undefined)
    ) {
      return;
    }

    setCompareRunRecords((current) =>
      buildHistoricalCompareRunRecords({
        selectedModelValues,
        modelLabelByValue,
        iterations: recentIterations,
        testCase: currentTestCase,
        existingRecords: current,
        preferredIteration: routeCompareAnchorIteration ?? null,
      }),
    );
  }, [
    currentTestCase,
    modelLabelByValue,
    recentIterations,
    routeCompareAnchorIteration,
    routeCompareAnchorIterationId,
    selectedModelValues,
  ]);

  useEffect(() => {
    if (!currentTestCase?._id) {
      return;
    }

    setActiveCompareRunId((current) => {
      if (current) {
        return current;
      }
      if (routeCompareAnchorIterationId) {
        return routeCompareAnchorRunId;
      }
      return latestHistoricalCompareRunId;
    });
  }, [
    currentTestCase?._id,
    latestHistoricalCompareRunId,
    routeCompareAnchorIterationId,
    routeCompareAnchorRunId,
  ]);

  useEffect(() => {
    setPersistedTestCaseModelValue(
      selectedTestCaseId,
      selectedModelValues[0] ?? null,
    );
  }, [selectedModelValues, selectedTestCaseId]);

  useEffect(() => {
    if (selectedModelValues.length > 0) {
      setAddModelMenuOpen(false);
    }
  }, [selectedModelValues.length]);

  useEffect(() => {
    if (selectedModelValues.length > 0 || modelOptions.length === 0) {
      return;
    }

    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAddModelMenuOpen(true);
      }
    };

    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [modelOptions.length, selectedModelValues.length]);

  useEffect(() => {
    setMobileVisibleModelValue((current) =>
      current && selectedModelValues.includes(current)
        ? current
        : (selectedModelValues[0] ?? null),
    );
  }, [selectedModelValues]);

  const addableModelOptions = useMemo(
    () =>
      modelOptions.filter(
        (option) => !selectedModelValues.includes(option.value),
      ),
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

  const openRunView = useCallback(
    (source: "run_compare" | "config_toggle") => {
      setEditorMode("run");
      setMobileVisibleModelValue((current) =>
        current && selectedModelValues.includes(current)
          ? current
          : (selectedModelValues[0] ?? null),
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
    },
    [currentTestCase?._id, selectedModelValues, suiteId],
  );

  const handleAddModel = (modelValue: string) => {
    setSelectedModelValues((previous) => {
      if (previous.includes(modelValue)) {
        return previous;
      }
      return [...previous, modelValue].slice(0, 3);
    });
  };

  const handleRemoveModel = (modelValue: string) => {
    setSelectedModelValues((previous) =>
      previous.filter((value) => value !== modelValue),
    );
  };

  const handleMakePrimaryModel = (modelValue: string) => {
    setSelectedModelValues((previous) => {
      if (!previous.includes(modelValue)) {
        return previous;
      }
      const rest = previous.filter((value) => value !== modelValue);
      return [modelValue, ...rest];
    });
  };

  const handlePrimaryModelChange = (modelValue: string) => {
    setSelectedModelValues((previous) => {
      const tail = previous.slice(1).filter((v) => v !== modelValue);
      return [modelValue, ...tail].slice(0, 3);
    });
  };

  const handleReplaceModelAt = (index: number, newValue: string) => {
    setSelectedModelValues((previous) => {
      if (previous[index] === newValue) {
        return previous;
      }
      const next = [...previous];
      const otherIndex = next.findIndex(
        (v, idx) => v === newValue && idx !== index,
      );
      if (otherIndex >= 0) {
        next[otherIndex] = next[index];
      }
      next[index] = newValue;
      return next;
    });
  };

  const handleStopCompare = useCallback(() => {
    compareRunUserStoppedRef.current = true;
    for (const controller of Object.values(
      compareAbortControllersRef.current,
    )) {
      controller.abort();
    }
  }, []);

  const handleRunCompare = async (options?: {
    modelValues?: string[];
    sessionMode?: "new" | "reuse";
  }) => {
    if (!currentTestCase || !suite || !editForm) {
      return;
    }

    const runModelValues = (options?.modelValues ?? selectedModelValues).filter(
      Boolean,
    );
    if (runModelValues.length === 0) {
      toast.error("Select at least one model to run.");
      return;
    }

    if (!validatePromptTurns(editForm.promptTurns)) {
      toast.error(
        getPromptTurnBlockReason(editForm.promptTurns) ??
          "Fix the test configuration before running.",
      );
      return;
    }

    const savePayload = buildSavePayload(editForm);
    const comparePreviewTrace = buildComparePreviewTrace(
      resolvePromptTurns(savePayload),
    );
    compareRunUserStoppedRef.current = false;
    const reusableCompareRunId =
      options?.sessionMode === "reuse"
        ? (activeCompareRunId ?? latestHistoricalCompareRunId)
        : null;
    const compareRunId = reusableCompareRunId ?? createCompareSessionId();
    const startsNewCompareSession = reusableCompareRunId == null;

    if (startsNewCompareSession) {
      try {
        await persistSelectedCompareModels(selectedModelValues);
      } catch (error) {
        console.error("Failed to save compare model selection:", error);
        toast.error(
          getBillingErrorMessage(
            error,
            "Failed to save compare models before running",
          ),
        );
        return;
      }
      setRouteCompareAnchorIterationId(null);
    }
    setActiveCompareRunId(compareRunId);

    let preparedRuns: Array<{
      modelValue: string;
      modelLabel: string;
      request: Awaited<ReturnType<typeof prepareSingleTestCaseRun>>;
    }> = [];
    const preparationFailures: Array<{
      modelValue: string;
      modelLabel: string;
      error: unknown;
    }> = [];

    const preparedResults = await Promise.allSettled(
      runModelValues.map(async (modelValue) => {
        const modelLabel = resolveModelOptionLabel(
          modelValue,
          modelLabelByValue,
        );
        const advancedConfig = mergeAdvancedConfigWithOverride({
          baseAdvancedConfig: savePayload.advancedConfig,
          override: undefined,
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
            isNegativeTest: savePayload.isNegativeTest,
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

    for (const [index, preparedResult] of preparedResults.entries()) {
      const modelValue = runModelValues[index]!;
      const modelLabel = resolveModelOptionLabel(modelValue, modelLabelByValue);

      if (preparedResult.status === "fulfilled") {
        preparedRuns.push(preparedResult.value);
        continue;
      }

      console.error(
        `Failed to prepare compare run for model ${modelValue}:`,
        preparedResult.reason,
      );
      preparationFailures.push({
        modelValue,
        modelLabel,
        error: preparedResult.reason,
      });
    }

    if (preparedRuns.length === 0) {
      toast.error(
        getBillingErrorMessage(
          preparationFailures[0]?.error,
          "Failed to prepare compare run",
        ),
      );
      return;
    }

    const totalRequestedModels = runModelValues.length;
    const modelRequestGen: Record<string, number> = {};
    for (const { modelValue } of preparedRuns) {
      const nextGen =
        (compareRequestGenByModelRef.current[modelValue] ?? 0) + 1;
      compareRequestGenByModelRef.current[modelValue] = nextGen;
      modelRequestGen[modelValue] = nextGen;
    }

    compareHandlesInFlightRef.current += 1;
    setIsRunningCompare(true);
    const previewExpectedToolCalls = flattenAssertedExpectedToolCalls(savePayload);
    const defaultRunColumnTab: RunColumnTab =
      previewExpectedToolCalls.length > 0 ? "tools" : "chat";
    setRunColumnTabByModel((previous) => ({
      ...previous,
      ...Object.fromEntries(
        runModelValues.map((modelValue) => [
          modelValue,
          defaultRunColumnTab,
        ]),
      ),
    }));
    setCompareRunRecords((previous) => {
      const allowed = new Set(selectedModelValues);
      const next: Record<string, CompareRunRecord> = {};
      for (const key of Object.keys(previous)) {
        if (allowed.has(key)) {
          next[key] = previous[key];
        }
      }
      const startedAt = Date.now();
      for (const { modelValue, modelLabel } of preparedRuns) {
        const prior = previous[modelValue];
        const isRetrying =
          prior != null &&
          (prior.iteration != null ||
            prior.status === "failed" ||
            prior.status === "cancelled");
        next[modelValue] = {
          ...buildCompareRunRecord({
            modelValue,
            modelLabel,
            iteration: null,
            startedAt,
          }),
          status: "running",
          isRetrying,
          startedAt,
          completedAt: null,
          error: null,
          previewTrace: comparePreviewTrace,
          previewExpectedToolCalls,
        };
      }
      for (const { modelValue, modelLabel, error } of preparationFailures) {
        next[modelValue] = buildCompareRunRecord({
          modelValue,
          modelLabel,
          iteration: null,
          error: getBillingErrorMessage(error, "Failed to prepare compare run"),
          startedAt: null,
          completedAt: Date.now(),
        });
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
      model_count: totalRequestedModels,
      models: runModelValues,
    });

    // Abort any previous streaming runs for models we're about to re-run
    for (const { modelValue } of preparedRuns) {
      compareAbortControllersRef.current[modelValue]?.abort();
    }

    try {
      const completedRecords = await Promise.all(
        preparedRuns.map(async ({ modelValue, modelLabel, request }) => {
          const myGen = modelRequestGen[modelValue];
          const abortController = new AbortController();
          compareAbortControllersRef.current[modelValue] = abortController;

          try {
            await streamEvalTestCase(
              {
                ...request.request,
                compareRunId,
                skipLastMessageRunUpdate: true,
              },
              (event) => {
                if (compareRequestGenByModelRef.current[modelValue] !== myGen)
                  return;

                if (event.type === "complete") {
                  const record = buildCompareRunRecord({
                    modelValue,
                    modelLabel,
                    iteration: (event.iteration as EvalIteration) ?? null,
                    completedAt: Date.now(),
                  });
                  setCompareRunRecords((previous) => ({
                    ...previous,
                    [modelValue]: {
                      ...record,
                      streamingTrace: previous[modelValue]?.streamingTrace,
                      streamingDraftMessages:
                        previous[modelValue]?.streamingDraftMessages,
                      streamingActualToolCalls:
                        previous[modelValue]?.streamingActualToolCalls,
                      streamingMetrics: previous[modelValue]?.streamingMetrics,
                    },
                  }));

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
                  return;
                }

                if (event.type === "error") {
                  setCompareRunRecords((previous) => {
                    const existing = previous[modelValue];
                    const failedRecord: CompareRunRecord = {
                      ...buildCompareRunRecord({
                        modelValue,
                        modelLabel,
                        iteration: null,
                        error: event.message,
                        startedAt: existing?.startedAt ?? Date.now(),
                        completedAt: Date.now(),
                      }),
                      status: "failed",
                      error: event.message,
                      streamingTrace: existing?.streamingTrace,
                      streamingDraftMessages: existing?.streamingDraftMessages,
                      streamingActualToolCalls:
                        existing?.streamingActualToolCalls,
                      streamingMetrics: existing?.streamingMetrics,
                    };
                    return {
                      ...previous,
                      [modelValue]: failedRecord,
                    };
                  });
                  return;
                }

                // Reduce stream event into progressive state
                setCompareRunRecords((previous) => {
                  const existing = previous[modelValue];
                  if (!existing) return previous;
                  const streamState = reduceEvalStreamEvent(
                    {
                      trace: existing.streamingTrace ?? null,
                      draftMessages: existing.streamingDraftMessages ?? [],
                      actualToolCalls: existing.streamingActualToolCalls ?? [],
                      tokensUsed: existing.streamingMetrics?.tokensUsed ?? 0,
                      toolCallCount:
                        existing.streamingMetrics?.toolCallCount ?? 0,
                      currentTurnIndex: initialEvalStreamState.currentTurnIndex,
                    },
                    event,
                  );
                  return {
                    ...previous,
                    [modelValue]: {
                      ...existing,
                      streamingTrace: streamState.trace ?? undefined,
                      streamingDraftMessages: streamState.draftMessages,
                      streamingActualToolCalls: streamState.actualToolCalls,
                      streamingMetrics: {
                        tokensUsed: streamState.tokensUsed,
                        toolCallCount: streamState.toolCallCount,
                      },
                    },
                  };
                });
              },
              abortController.signal,
            );

            // Stream completed — return the final record
            return new Promise<CompareRunRecord>((resolve) => {
              // Read the latest state after stream is done
              setCompareRunRecords((previous) => {
                resolve(
                  previous[modelValue] ??
                    buildCompareRunRecord({
                      modelValue,
                      modelLabel,
                      iteration: null,
                      completedAt: Date.now(),
                    }),
                );
                return previous;
              });
            });
          } catch (error) {
            if (abortController.signal.aborted) {
              let resolved!: CompareRunRecord;
              setCompareRunRecords((previous) => {
                const existing = previous[modelValue];
                // A retry starts a newer request for this model and aborts the
                // old controller. If that old abort rejects later, it must not
                // overwrite the newer running/completed row as cancelled.
                if (
                  compareRequestGenByModelRef.current[modelValue] !== myGen
                ) {
                  resolved =
                    existing ??
                    buildCompareRunRecord({
                      modelValue,
                      modelLabel,
                      iteration: null,
                      completedAt: Date.now(),
                    });
                  return previous;
                }
                const base = buildCompareRunRecord({
                  modelValue,
                  modelLabel,
                  iteration: null,
                  cancelled: true,
                  startedAt: existing?.startedAt ?? null,
                  completedAt: Date.now(),
                });
                const tokensUsed =
                  existing?.streamingMetrics?.tokensUsed ??
                  existing?.metrics.tokensUsed ??
                  0;
                const toolCallCount =
                  existing?.streamingMetrics?.toolCallCount ??
                  existing?.metrics.toolCallCount ??
                  0;
                resolved = {
                  ...base,
                  streamingTrace: existing?.streamingTrace,
                  streamingDraftMessages: existing?.streamingDraftMessages,
                  streamingActualToolCalls: existing?.streamingActualToolCalls,
                  streamingMetrics:
                    existing?.streamingMetrics != null
                      ? existing.streamingMetrics
                      : undefined,
                  metrics: {
                    ...base.metrics,
                    toolCallCount,
                    tokensUsed,
                  },
                };
                return { ...previous, [modelValue]: resolved };
              });
              return resolved;
            }
            const message = getBillingErrorMessage(
              error,
              "Failed to run model",
            );
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

            if (compareRequestGenByModelRef.current[modelValue] === myGen) {
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

      const successfulCount = completedRecords.filter(
        (record) => record.iteration != null,
      ).length;
      if (compareRunUserStoppedRef.current) {
        toast.message("Compare run stopped.");
      } else if (successfulCount === totalRequestedModels) {
        toast.success(
          `Compare run finished across ${totalRequestedModels} model${
            totalRequestedModels === 1 ? "" : "s"
          }.`,
        );
      } else if (successfulCount > 0) {
        toast.error(
          `${successfulCount}/${totalRequestedModels} model${
            totalRequestedModels === 1 ? "" : "s"
          } completed successfully.`,
        );
      } else {
        toast.error("Compare run failed for all selected models.");
      }
    } finally {
      compareHandlesInFlightRef.current -= 1;
      if (compareHandlesInFlightRef.current === 0) {
        setIsRunningCompare(false);
      }
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
      toast.error(
        getBillingErrorMessage(error, "Failed to clear latest result"),
      );
    }
  };

  const handleRunColumnTabChange = (modelValue: string, tab: RunColumnTab) => {
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

  const compareRouteLoadingState = (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-xs text-muted-foreground">Loading results...</p>
      </div>
    </div>
  );
  const isCompareRouteLoading =
    openCompareFromRoute &&
    (testCases === undefined ||
      (currentTestCase?._id != null &&
        initializedSelectionCaseRef.current !== currentTestCase._id) ||
      (currentTestCase?._id != null && recentIterations === undefined) ||
      (routeCompareAnchorIterationId != null &&
        routeCompareAnchorIteration === undefined));

  if (!currentTestCase) {
    if (isCompareRouteLoading) {
      return compareRouteLoadingState;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading test case...</p>
      </div>
    );
  }

  const connectedServerList = (suite?.environment?.servers || []).filter(
    (name: string) => connectedServerNames.has(name),
  );
  const runGridClassName =
    selectedCompareRecords.length <= 1
      ? "lg:grid-cols-1"
      : selectedCompareRecords.length === 2
        ? "lg:grid-cols-2"
        : "lg:grid-cols-3";
  const latestAvailableIteration =
    routeCompareAnchorIteration ??
    recentIterations?.[0] ??
    lastSavedIteration ??
    null;
  const latestAvailableResult = latestAvailableIteration
    ? computeIterationResult(latestAvailableIteration)
    : null;
  /** Visual + a11y cue on View results / Open last run (replaces header status chip). */
  const latestRunNavCue =
    latestAvailableResult === "failed"
      ? {
          dotClass:
            "size-1.5 shrink-0 rounded-full bg-rose-500 dark:bg-rose-400",
          buttonTextClass: "text-rose-700 dark:text-rose-300",
          ariaResults: "View results, last run failed",
          ariaOpen: "Open last run, failed",
        }
      : latestAvailableResult === "passed"
        ? {
            dotClass:
              "size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400",
            buttonTextClass: "text-emerald-700 dark:text-emerald-300",
            ariaResults: "View results, last run passed",
            ariaOpen: "Open last run passed",
          }
        : latestAvailableResult === "cancelled"
          ? {
              dotClass:
                "size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400",
              buttonTextClass: "text-amber-800 dark:text-amber-200",
              ariaResults: "View results, last run stopped",
              ariaOpen: "Open last run stopped",
            }
          : {
              dotClass:
                "size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse motion-reduce:animate-none",
              buttonTextClass: "text-amber-800 dark:text-amber-200",
              ariaResults: "View results, run in progress",
              ariaOpen: "Open last run, in progress",
            };
  const latestAvailableIsSaved =
    Boolean(latestAvailableIteration?._id) &&
    latestAvailableIteration?._id === currentTestCase.lastMessageRun;
  const canOpenLastRun =
    Boolean(onOpenLastRun) &&
    Boolean(lastSavedIteration?.suiteRunId) &&
    Boolean(lastSavedIteration?._id);

  if (editorMode === "run" && isCompareRouteLoading) {
    return compareRouteLoadingState;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {editorMode === "config" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-6 pb-3 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {onBackToList ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-7 self-start px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    onClick={onBackToList}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to cases
                  </Button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    {isEditingTitle ? (
                      <input
                        type="text"
                        value={editForm?.title || ""}
                        onChange={(event) =>
                          editForm &&
                          setEditForm({
                            ...editForm,
                            title: event.target.value,
                          })
                        }
                        onBlur={handleTitleBlur}
                        onKeyDown={handleTitleKeyDown}
                        autoFocus
                        className="min-w-0 flex-1 bg-transparent px-0 py-0 text-xl font-semibold tracking-tight focus:outline-none sm:text-2xl"
                      />
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={handleTitleClick}
                      >
                        <h2 className="truncate text-xl font-semibold tracking-tight transition-opacity hover:opacity-80 sm:text-2xl">
                          {editForm?.title || currentTestCase.title}
                        </h2>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {latestAvailableIteration ? (
                  hasRunViewContent ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-1.5 px-2 text-xs",
                        latestRunNavCue.buttonTextClass,
                      )}
                      aria-label={latestRunNavCue.ariaResults}
                      onClick={() => openRunView("config_toggle")}
                    >
                      <span className={latestRunNavCue.dotClass} aria-hidden />
                      View results
                    </Button>
                  ) : canOpenLastRun ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-1.5 px-2 text-xs",
                        latestRunNavCue.buttonTextClass,
                      )}
                      aria-label={latestRunNavCue.ariaOpen}
                      onClick={() =>
                        lastSavedIteration &&
                        onOpenLastRun?.(lastSavedIteration)
                      }
                    >
                      <span className={latestRunNavCue.dotClass} aria-hidden />
                      Open last run
                    </Button>
                  ) : null
                ) : null}
                {onExportDraft ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => handleExport()}
                    disabled={!editForm}
                  >
                    <Code2 className="mr-2 h-3.5 w-3.5" />
                    Setup SDK
                  </Button>
                ) : null}
                {hasUnsavedChanges ? (
                  saveDisabledTooltip ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8"
                            onClick={() => void handleSave()}
                            disabled={savePrimaryDisabled}
                          >
                            <Save className="mr-2 h-3.5 w-3.5" />
                            Save
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent variant="muted" side="top" sideOffset={6}>
                        {saveDisabledTooltip}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void handleSave()}
                      disabled={savePrimaryDisabled}
                    >
                      <Save className="mr-2 h-3.5 w-3.5" />
                      Save
                    </Button>
                  )
                ) : null}
                {runDisabledTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          onClick={() => void handleRunCompare()}
                          disabled={runPrimaryDisabled}
                        >
                          {isRunningCompare ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Running…
                            </>
                          ) : (
                            <>
                              <Play className="size-3.5 fill-current" />
                              {selectedModelValues.length > 1
                                ? "Run compare"
                                : "Run"}
                            </>
                          )}
                        </Button>
                        {isRunningCompare ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            onClick={handleStopCompare}
                          >
                            <Square className="size-3.5 opacity-90" />
                            Stop
                          </Button>
                        ) : null}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent variant="muted" side="top" sideOffset={6}>
                      {runDisabledTooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="h-8"
                      onClick={() => void handleRunCompare()}
                      disabled={runPrimaryDisabled}
                    >
                      {isRunningCompare ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Running…
                        </>
                      ) : (
                        <>
                          <Play className="size-3.5 fill-current" />
                          {selectedModelValues.length > 1
                            ? "Run compare"
                            : "Run"}
                        </>
                      )}
                    </Button>
                    {isRunningCompare ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        onClick={handleStopCompare}
                      >
                        <Square className="size-3.5 opacity-90" />
                        Stop
                      </Button>
                    ) : null}
                  </span>
                )}
              </div>
            </div>

            <div>
              <div
                className="rounded-xl bg-[#f8f5f1] py-2.5 dark:bg-muted/10"
                title={
                  !latestAvailableIsSaved &&
                  currentTestCase.lastMessageRun &&
                  latestAvailableIteration
                    ? "The saved latest result is older than this run."
                    : undefined
                }
              >
                <div className="flex min-h-9 items-center gap-2 px-4">
                  {!latestAvailableIteration ? (
                    <span className="shrink-0 text-[13px] font-normal text-[#777777] dark:text-muted-foreground">
                      Add model
                    </span>
                  ) : null}

                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {selectedModelValues.length === 0 ? (
                        modelOptions.length === 0 ? (
                          <span className="text-[13px] text-muted-foreground">
                            No models
                          </span>
                        ) : (
                          <DropdownMenu
                            open={addModelMenuOpen}
                            onOpenChange={setAddModelMenuOpen}
                          >
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex h-8 max-w-[180px] shrink-0 items-center gap-2 rounded-full border border-border/60 bg-white px-2.5 text-left text-xs font-medium text-foreground shadow-none transition-colors hover:bg-muted/80 dark:bg-background dark:hover:bg-muted/40"
                              >
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">Add model</span>
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="start"
                              className="max-h-64 overflow-y-auto"
                            >
                              {modelOptions.map((option) => (
                                <DropdownMenuItem
                                  key={option.value}
                                  onClick={() => handleAddModel(option.value)}
                                >
                                  {option.label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )
                      ) : (
                        <>
                          {selectedModelValues.map((modelValue, index) => {
                            const option = modelOptionByValue[modelValue];
                            const label = resolveModelOptionLabel(
                              modelValue,
                              modelLabelByValue,
                            );
                            const isSingleSelection =
                              selectedModelValues.length === 1;

                            return (
                              <div
                                key={modelValue}
                                className={cn(
                                  "flex h-8 max-w-[180px] shrink-0 items-center gap-1 rounded-full border px-2",
                                  index === 0
                                    ? "border-primary/25 bg-primary/5 text-foreground"
                                    : "border-border/50 bg-muted/30 text-muted-foreground",
                                )}
                              >
                                <ProviderLogo
                                  provider={option?.provider ?? "custom"}
                                  className="size-3.5 shrink-0"
                                />
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate text-xs font-medium",
                                    index === 0
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {compactModelLabel(label)}
                                </span>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                                      aria-label={`Model options (${label})`}
                                    >
                                      <MoreHorizontal className="h-3.5 w-3.5" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="start"
                                    className="max-h-64 w-52 overflow-y-auto"
                                  >
                                    {modelOptions.length === 0 ? (
                                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                        No models available
                                      </div>
                                    ) : (
                                      modelOptions.map((opt) => (
                                        <DropdownMenuItem
                                          key={opt.value}
                                          onClick={() =>
                                            isSingleSelection
                                              ? handlePrimaryModelChange(
                                                  opt.value,
                                                )
                                              : handleReplaceModelAt(
                                                  index,
                                                  opt.value,
                                                )
                                          }
                                        >
                                          {opt.label}
                                        </DropdownMenuItem>
                                      ))
                                    )}
                                    {index > 0 ? (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                          onClick={() =>
                                            handleMakePrimaryModel(modelValue)
                                          }
                                        >
                                          Make lead model
                                        </DropdownMenuItem>
                                      </>
                                    ) : null}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="text-destructive focus:text-destructive"
                                      onClick={() =>
                                        handleRemoveModel(modelValue)
                                      }
                                    >
                                      Remove
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                <button
                                  type="button"
                                  className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                                  aria-label={`Remove ${label}`}
                                  onClick={() => handleRemoveModel(modelValue)}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                          {addableModelOptions.length > 0 &&
                          selectedModelValues.length < 3 ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-white text-foreground transition-colors hover:bg-muted/80 dark:bg-background dark:hover:bg-muted/50"
                                  aria-label="Add model to compare"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="max-h-64 overflow-y-auto"
                              >
                                {addableModelOptions.map((option) => (
                                  <DropdownMenuItem
                                    key={option.value}
                                    onClick={() => handleAddModel(option.value)}
                                  >
                                    {option.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </>
                      )}
                    </div>

                    {selectedModelValues.length > 1 ? (
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-[#9e9e9e] hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
                        aria-label="Use lead model only"
                        onClick={() =>
                          setSelectedModelValues((previous) =>
                            previous.slice(0, 1),
                          )
                        }
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-1">
              {editForm ? (
                <TestCasePromptFlow
                  promptTurns={editForm.promptTurns}
                  expandedPromptTurnIds={expandedPromptTurnIds}
                  availableTools={availableTools}
                  evalValidationBorderClass={evalValidationBorderClass}
                  isStepPromptEmpty={isStepPromptEmpty}
                  stepExpectedToolsNeedAttention={
                    stepExpectedToolsNeedAttention
                  }
                  updatePromptTurn={updatePromptTurn}
                  addPromptTurn={addPromptTurn}
                  removePromptTurn={removePromptTurn}
                  movePromptTurn={movePromptTurn}
                  togglePromptTurnExpanded={togglePromptTurnExpanded}
                />
              ) : null}
            </div>

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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-b px-4 py-3 sm:px-6">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {onBackToList ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-7 shrink-0 px-2 text-xs text-muted-foreground"
                  onClick={onBackToList}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to cases
                </Button>
              ) : null}
              <div className="min-w-0 flex-1 truncate text-lg font-semibold sm:text-xl">
                {editForm?.title || currentTestCase.title}
              </div>
              {selectedCompareRecords.length > 0 ? (
                runDisabledTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 shrink-0 text-xs"
                          onClick={() => void handleRunCompare()}
                          disabled={runPrimaryDisabled}
                        >
                          {isRunningCompare ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Running…
                            </>
                          ) : (
                            <>
                              <RotateCw className="size-3.5" />
                              Retry all
                            </>
                          )}
                        </Button>
                        {isRunningCompare ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 shrink-0 px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            onClick={handleStopCompare}
                          >
                            <Square className="size-3.5 opacity-90" />
                            Stop
                          </Button>
                        ) : null}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      variant="muted"
                      side="bottom"
                      sideOffset={6}
                    >
                      {runDisabledTooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => void handleRunCompare()}
                      disabled={runPrimaryDisabled}
                    >
                      {isRunningCompare ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Running…
                        </>
                      ) : (
                        <>
                          <RotateCw className="size-3.5" />
                          Retry all
                        </>
                      )}
                    </Button>
                    {isRunningCompare ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        onClick={handleStopCompare}
                      >
                        <Square className="size-3.5 opacity-90" />
                        Stop
                      </Button>
                    ) : null}
                  </span>
                )
              ) : null}
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
                    onClick={() =>
                      setMobileVisibleModelValue(record.modelValue)
                    }
                  >
                    {record.modelLabel}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-6">
            {selectedCompareRecords.length === 0 ? (
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center">
                <div>
                  <div className="text-sm font-medium">No compare run yet</div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Choose at least one model and run compare from the prompt
                    editor.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  "grid min-h-0 min-w-0 flex-1 gap-4",
                  // Below lg, models stack: equal-height rows (1fr each) crush traces; size rows
                  // to content and scroll this panel instead.
                  "max-lg:auto-rows-min max-lg:overflow-y-auto",
                  "lg:auto-rows-[minmax(0,1fr)] lg:overflow-hidden",
                  runGridClassName,
                )}
              >
                {selectedCompareRecords.map((record) => {
                  const showOnMobile =
                    selectedCompareRecords.length <= 1 ||
                    mobileVisibleModelValue === record.modelValue;

                  return (
                    <div
                      key={record.modelValue}
                      className={cn(
                        showOnMobile ? "block" : "hidden",
                        "min-h-0 min-w-0 flex flex-col lg:block",
                      )}
                    >
                      <RunColumn
                        record={record}
                        allRecords={selectedCompareRecords}
                        testCase={currentTestCase}
                        serverNames={connectedServerList}
                        workspaceId={workspaceId}
                        onStreamingTraceLoaded={() =>
                          clearCompareStreamingState(record.modelValue)
                        }
                        activeTab={
                          runColumnTabByModel[record.modelValue] ?? "tools"
                        }
                        onTabChange={(tab) =>
                          handleRunColumnTabChange(record.modelValue, tab)
                        }
                        onRetry={() =>
                          void handleRunCompare({
                            modelValues: [record.modelValue],
                            sessionMode: "reuse",
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
    </div>
  );
}

function RunColumn({
  record,
  allRecords,
  testCase,
  serverNames,
  workspaceId,
  onContinueInChat,
  onStreamingTraceLoaded,
  activeTab,
  onTabChange,
  onRetry,
}: {
  record: CompareRunRecord;
  allRecords: CompareRunRecord[];
  testCase: any;
  serverNames: string[];
  workspaceId: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  onStreamingTraceLoaded: () => void;
  activeTab: RunColumnTab;
  onTabChange: (tab: RunColumnTab) => void;
  onRetry: () => void;
}) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);
  const { toolsMetadata, toolServerMap, connectedServerIds } =
    useEvalTraceToolContext({
      serverNames,
      workspaceId,
      retryKey:
        record.iteration?._id ??
        record.startedAt ??
        record.completedAt ??
        record.modelValue,
    });
  // Prefer the iteration snapshot (authoritative) once available; otherwise
  // fall back to previewExpectedToolCalls captured from the in-memory form at
  // run-start so unsaved edits are reflected in showToolsTab / the pre-stream
  // Results preview before the persisted testCase is updated.
  const expectedToolCalls = record.iteration?.testCaseSnapshot
    ? resolveIterationDisplayExpectedToolCalls(record.iteration.testCaseSnapshot, null)
    : record.previewExpectedToolCalls != null
      ? record.previewExpectedToolCalls
      : resolveIterationDisplayExpectedToolCalls(null, testCase);
  const actualToolCalls =
    record.iteration?.actualToolCalls ?? record.streamingActualToolCalls ?? [];
  const showToolsTab =
    expectedToolCalls.length > 0 || actualToolCalls.length > 0;

  const effectiveActiveTab: RunColumnTab =
    activeTab === "tools" && !showToolsTab ? "timeline" : activeTab;

  const traceMode =
    effectiveActiveTab === "chat"
      ? "chat"
      : effectiveActiveTab === "timeline"
        ? "timeline"
        : effectiveActiveTab === "raw"
          ? "raw"
          : "tools";
  const streamingTraceEnvelope = useMemo(
    () =>
      mergeStreamingTrace(record.streamingTrace, record.streamingDraftMessages),
    [record.streamingDraftMessages, record.streamingTrace],
  );
  const {
    blob: persistedTraceBlob,
    loading: persistedTraceLoading,
    error: persistedTraceError,
  } = useEvalTraceBlob({
    iteration: record.iteration,
    onTraceLoaded: onStreamingTraceLoaded,
    enabled: !!record.iteration,
  });
  const continueInChatPayload = useMemo(() => {
    if (!onContinueInChat) {
      return null;
    }

    const sourceTrace = (persistedTraceBlob ??
      streamingTraceEnvelope) as Record<string, unknown> | null;

    if (!sourceTrace) {
      return null;
    }

    const adaptedTrace = adaptTraceToUiMessages({
      trace: sourceTrace as any,
      toolsMetadata: toolsMetadata as Record<string, Record<string, any>>,
      toolServerMap,
      connectedServerIds,
    });

    if (adaptedTrace.messages.length === 0) {
      return null;
    }

    const advancedConfig =
      record.iteration?.testCaseSnapshot?.advancedConfig ??
      testCase?.advancedConfig;
    const systemPrompt =
      typeof advancedConfig?.system === "string"
        ? advancedConfig.system
        : undefined;
    const temperature =
      typeof advancedConfig?.temperature === "number"
        ? advancedConfig.temperature
        : undefined;

    return {
      messages: adaptedTrace.messages,
      serverNames,
      modelId: record.model,
      systemPrompt,
      temperature,
    } satisfies Omit<EvalChatHandoff, "id">;
  }, [
    connectedServerIds,
    onContinueInChat,
    persistedTraceBlob,
    record.iteration?.testCaseSnapshot?.advancedConfig,
    record.model,
    serverNames,
    streamingTraceEnvelope,
    testCase?.advancedConfig,
    toolServerMap,
    toolsMetadata,
  ]);
  const hasStreamingTrace = streamingTraceEnvelope != null;
  const previewTrace = record.previewTrace ?? null;
  const activeLiveChatTrace: TraceEnvelope | null =
    (hasStreamingTrace ? streamingTraceEnvelope : previewTrace) ?? null;
  const isWaitingForFirstTimelineSnapshot =
    traceMode === "timeline" &&
    record.iteration == null &&
    record.streamingTrace == null &&
    hasStreamingTrace;
  const shouldRenderChatShell = effectiveActiveTab === "chat";
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  const displayTokens =
    record.streamingMetrics?.tokensUsed ?? record.metrics.tokensUsed;
  const toolCount =
    record.streamingMetrics?.toolCallCount ?? record.metrics.toolCallCount;
  const isRunningRecord = record.status === "running";

  const toSummaryStatus = (
    r: CompareRunRecord,
  ): MultiModelCardSummary["status"] => {
    if (r.status === "running") return "running";
    if (r.status === "cancelled" || r.result === "cancelled") return "cancelled";
    if (r.status === "failed" || r.result === "failed") return "error";
    if (r.iteration != null || r.status === "completed") return "ready";
    return "idle";
  };

  const runColumnSummary: MultiModelCardSummary = {
    modelId: record.modelValue,
    durationMs: record.metrics.durationMs,
    tokens: displayTokens,
    toolCount,
    status: toSummaryStatus(record),
    hasMessages:
      record.iteration != null ||
      record.streamingTrace != null ||
      (record.streamingDraftMessages?.length ?? 0) > 0,
  };

  const allRunSummaries: MultiModelCardSummary[] = allRecords.map((r) => {
    const rTokens = r.streamingMetrics?.tokensUsed ?? r.metrics.tokensUsed;
    const rToolCount =
      r.streamingMetrics?.toolCallCount ?? r.metrics.toolCallCount;
    return {
      modelId: r.modelValue,
      durationMs: r.metrics.durationMs,
      tokens: rTokens,
      toolCount: rToolCount,
      status: toSummaryStatus(r),
      hasMessages:
        r.iteration != null ||
        r.streamingTrace != null ||
        (r.streamingDraftMessages?.length ?? 0) > 0,
    };
  });

  const runColumnResult: "passed" | "failed" | null =
    record.result === "passed"
      ? "passed"
      : record.result === "failed" || record.status === "failed"
        ? "failed"
        : null;
  const renderedRunContent = record.iteration ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {traceMode === "chat" ? (
        <CompareRunChatSurface
          iteration={record.iteration}
          traceModel={{
            id: record.model,
            name: record.modelLabel,
            provider: record.provider as any,
          }}
          isLoading={isRunningRecord}
          emptyMessage={`No ${activeTab} data is available for this run.`}
          fallbackTrace={streamingTraceEnvelope}
          onTraceLoaded={onStreamingTraceLoaded}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          traceBlob={persistedTraceBlob}
          traceBlobLoading={persistedTraceLoading}
          traceBlobError={persistedTraceError}
        />
      ) : (
        <EvalTraceSurface
          iteration={record.iteration}
          testCase={testCase}
          mode={traceMode}
          emptyMessage={`No ${activeTab} data is available for this run.`}
          fallbackTrace={streamingTraceEnvelope}
          fallbackActualToolCalls={actualToolCalls}
          onTraceLoaded={onStreamingTraceLoaded}
          onNavigateToChat={() => onTabChange("chat")}
          traceBlob={persistedTraceBlob}
          traceBlobLoading={persistedTraceLoading}
          traceBlobError={persistedTraceError}
          isLoading={isRunningRecord}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
        />
      )}
    </div>
  ) : hasStreamingTrace ? (
    isWaitingForFirstTimelineSnapshot ? (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/50 bg-muted/10 px-6 py-10 text-center">
        <div className="max-w-sm">
          <div className="text-sm font-medium">
            Timeline appears after the first step completes
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Chat and raw output are already streaming for the current in-flight
            step.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => onTabChange("chat")}
          >
            Switch to Chat
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TraceViewer
          trace={streamingTraceEnvelope}
          forcedViewMode={traceMode}
          isLoading={isRunningRecord}
          expectedToolCalls={expectedToolCalls}
          actualToolCalls={actualToolCalls}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          hideToolbar
          fillContent
        />
      </div>
    )
  ) : record.status === "running" && !record.iteration ? (
    (traceMode === "chat" || traceMode === "tools") && activeLiveChatTrace ? (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TraceViewer
          trace={activeLiveChatTrace}
          model={{
            id: record.model,
            name: record.modelLabel,
            provider: record.provider as any,
          }}
          forcedViewMode={traceMode === "tools" ? "tools" : "chat"}
          isLoading={true}
          expectedToolCalls={expectedToolCalls}
          actualToolCalls={actualToolCalls}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          hideToolbar
          fillContent
        />
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/50 bg-muted/10">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            {record.isRetrying ? "Retrying" : "Running"} {record.modelLabel}…
          </span>
        </div>
      </div>
    )
  ) : record.status === "cancelled" && !record.iteration ? (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/5 px-6 py-10">
      <div className="max-w-sm text-center">
        <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {record.modelLabel} stopped
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          This run was stopped before it finished. Partial trace and metrics
          may still be visible in the tabs above.
        </p>
      </div>
    </div>
  ) : record.status === "failed" && !record.iteration ? (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10">
      <div className="max-w-sm text-center">
        <div className="text-sm font-medium text-destructive">
          {record.modelLabel} failed
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {record.error || "No run data is available for this model."}
        </p>
      </div>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center">
      <div>
        <div className="text-sm font-medium">No run yet</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Run compare to load this model’s chat, trace, and tool details.
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex h-auto min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 lg:h-full">
      <ModelCompareCardHeader
        modelLabel={record.modelLabel}
        summary={runColumnSummary}
        allSummaries={allRunSummaries}
        mode={effectiveActiveTab}
        onModeChange={onTabChange}
        showTraceTabs
        showComparisonChrome
        compactCompareHeader={false}
        result={runColumnResult}
        showToolsTab={showToolsTab}
        tabsInline
        actionsSlot={
          <>
            {onContinueInChat ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() =>
                  continueInChatPayload &&
                  onContinueInChat(continueInChatPayload)
                }
                disabled={!continueInChatPayload}
              >
                Continue in Chat
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-[11px]"
              onClick={onRetry}
              disabled={
                record.status === "running" &&
                record.iteration == null &&
                !hasStreamingTrace
              }
            >
              <RotateCw
                className={cn(
                  "mr-1 h-3 w-3",
                  record.status === "running" &&
                    record.iteration == null &&
                    !hasStreamingTrace &&
                    "animate-spin",
                )}
              />
              Retry
            </Button>
          </>
        }
        footerNote={
          record.metrics.mismatchCount != null &&
          record.metrics.mismatchCount > 0 ? (
            <>
              {record.metrics.mismatchCount} mismatch
              {record.metrics.mismatchCount === 1 ? "" : "es"} across expected
              tool calls.
            </>
          ) : null
        }
      />

      <div className="flex min-w-0 max-lg:min-h-[min(52vh,26rem)] flex-1 flex-col overflow-hidden p-3 lg:min-h-0">
        {shouldRenderChatShell ? (
          <ChatboxHostStyleProvider value={hostStyle}>
            <ChatboxHostThemeProvider value={themeMode}>
              <div
                className={cn(
                  "chatbox-host-shell app-theme-scope flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50",
                  themeMode === "dark" && "dark",
                )}
                data-host-style={hostStyle}
                style={shellStyle}
              >
                <div className="shrink-0 px-3 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="shrink-0 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Host Styles
                    </p>
                    <HostStylePillSelector
                      className="w-[164px] shrink-0"
                      value={hostStyle}
                      onValueChange={setHostStyle}
                    />
                  </div>
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3 pt-2">
                  {renderedRunContent}
                </div>
              </div>
            </ChatboxHostThemeProvider>
          </ChatboxHostStyleProvider>
        ) : (
          renderedRunContent
        )}
      </div>
    </div>
  );
}
