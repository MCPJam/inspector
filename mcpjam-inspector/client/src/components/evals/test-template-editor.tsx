import {
  useCallback,
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
  MoreVertical,
  Play,
  Plus,
  RotateCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { listEvalTools, runEvalTestCase } from "@/lib/apis/evals-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExpectedToolsEditor } from "./expected-tools-editor";
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
  type TestCaseModelOption,
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
  CompareRunRecord,
  EditorMode,
  EvalIteration,
  RunColumnTab,
} from "./types";
import type { EvalExportDraftInput } from "@/lib/evals/eval-export";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";

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
  /** Deep link: open compare run surface once iteration data is ready (same as View results). */
  openCompareFromRoute?: boolean;
  /** Remove `compare=1` from the hash after handling {@link openCompareFromRoute}. */
  onClearOpenCompareRoute?: () => void;
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

/** When every step has no asserted tool calls, the case expects no tool usage (stored as isNegativeTest). */
function deriveIsNegativeTestFromPromptTurns(
  promptTurns: PromptTurn[],
): boolean {
  return promptTurns.every((turn) => turn.expectedToolCalls.length === 0);
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
  openCompareFromRoute = false,
  onClearOpenCompareRoute,
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
  const [addModelMenuOpen, setAddModelMenuOpen] = useState(false);
  const [compareRunRecords, setCompareRunRecords] = useState<
    Record<string, CompareRunRecord>
  >({});
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
    setExpandedPromptTurnIds([]);
    setArtifactDialog(null);
    initializedSelectionCaseRef.current = null;
    setAddModelMenuOpen(false);
  }, [selectedTestCaseId]);

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

    const effectiveNegativeOnServer = deriveIsNegativeTestFromPromptTurns(
      currentPromptTurns,
    );
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

  const buildSavePayload = (form: TestTemplate) => {
    const isNegativeTest = deriveIsNegativeTestFromPromptTurns(form.promptTurns);
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

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
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

  const openRunView = useCallback(
    (source: "run_compare" | "config_toggle") => {
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
    },
    [currentTestCase?._id, selectedModelValues, suiteId],
  );

  const openCompareRouteHandledRef = useRef(false);
  useEffect(() => {
    if (!openCompareFromRoute) {
      openCompareRouteHandledRef.current = false;
      return;
    }
    if (!onClearOpenCompareRoute || openCompareRouteHandledRef.current) {
      return;
    }
    if (!currentTestCase?._id || recentIterations === undefined) {
      return;
    }
    if (initializedSelectionCaseRef.current !== currentTestCase._id) {
      return;
    }
    if (selectedModelValues.length === 0) {
      const caseListsModels =
        (currentTestCase.models?.filter((m) => m.provider && m.model).length ??
          0) > 0;
      if (caseListsModels || modelOptions.length > 0) {
        return;
      }
      openCompareRouteHandledRef.current = true;
      onClearOpenCompareRoute();
      return;
    }
    if (!hasRunViewContent) {
      if (recentIterations.length === 0) {
        openCompareRouteHandledRef.current = true;
        onClearOpenCompareRoute();
      }
      return;
    }
    openCompareRouteHandledRef.current = true;
    openRunView("config_toggle");
    onClearOpenCompareRoute();
  }, [
    openCompareFromRoute,
    hasRunViewContent,
    recentIterations,
    onClearOpenCompareRoute,
    openRunView,
    currentTestCase?._id,
    selectedModelValues.length,
    modelOptions.length,
  ]);

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
      const otherIndex = next.findIndex((v, idx) => v === newValue && idx !== index);
      if (otherIndex >= 0) {
        next[otherIndex] = next[index];
      }
      next[index] = newValue;
      return next;
    });
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

    if (!validatePromptTurns(editForm.promptTurns)) {
      toast.error(
        getPromptTurnBlockReason(editForm.promptTurns) ??
          "Fix the test configuration before running.",
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

  const connectedServerList = (suite?.environment?.servers || []).filter(
    (name: string) => connectedServerNames.has(name),
  );
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
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6 lg:py-5">
            {onBackToList ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 h-8 w-fit px-2 text-xs text-muted-foreground"
                onClick={onBackToList}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to cases
              </Button>
            ) : null}

            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
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
                      className="min-w-0 flex-1 bg-transparent px-0 py-0 text-lg font-semibold focus:outline-none sm:text-xl"
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={handleTitleClick}
                    >
                      <h2 className="truncate text-lg font-semibold transition-opacity hover:opacity-80 sm:text-xl">
                        {editForm?.title || currentTestCase.title}
                      </h2>
                    </button>
                  )}
                  {latestAvailableIteration ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-sm font-medium",
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
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
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
                    Export
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
                {latestAvailableIteration ? (
                  hasRunViewContent ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => openRunView("config_toggle")}
                    >
                      Results
                    </Button>
                  ) : canOpenLastRun ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() =>
                        lastSavedIteration &&
                        onOpenLastRun?.(lastSavedIteration)
                      }
                    >
                      Open last run
                    </Button>
                  ) : null
                ) : null}
                {runDisabledTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          onClick={() => void handleRunCompare()}
                          disabled={runPrimaryDisabled}
                        >
                          {isRunningCompare ? (
                            <>
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              Running…
                            </>
                          ) : (
                            <>
                              <Play className="mr-2 h-3.5 w-3.5 fill-current" />
                              {selectedModelValues.length > 1
                                ? "Run compare"
                                : "Run"}
                            </>
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent variant="muted" side="top" sideOffset={6}>
                      {runDisabledTooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8"
                    onClick={() => void handleRunCompare()}
                    disabled={runPrimaryDisabled}
                  >
                    {isRunningCompare ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Running…
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-3.5 w-3.5 fill-current" />
                        {selectedModelValues.length > 1 ? "Run compare" : "Run"}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            <div>
              <div
                className="bg-[#fcfbf9] py-2 dark:bg-muted/15"
                title={
                  !latestAvailableIsSaved &&
                  currentTestCase.lastMessageRun &&
                  latestAvailableIteration
                    ? "The saved latest result is older than this run."
                    : undefined
                }
              >
                <div className="flex min-h-10 items-center gap-2.5 px-3">
                  {latestAvailableIteration ? (
                    <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      <span className="font-semibold tracking-normal text-foreground/75">
                        Run
                      </span>
                      <span className="text-[9px] opacity-40">/</span>
                      {latestAvailableTimestamp ? (
                        <span className="tabular-nums tracking-normal text-foreground/55">
                          {formatRelativeTime(latestAvailableTimestamp)}
                        </span>
                      ) : null}
                      {latestAvailableTimestamp && latestAvailableModelLabel ? (
                        <span className="text-[9px] opacity-40">/</span>
                      ) : null}
                      {latestAvailableModelLabel ? (
                        <span className="max-w-[5.5rem] truncate tracking-normal text-foreground/45 normal-case">
                          {latestAvailableModelLabel}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          "ml-0.5 rounded-sm px-1 py-px text-[9px] font-semibold tracking-normal normal-case",
                          latestAvailableIsSaved
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-amber-500/15 text-amber-800 dark:text-amber-300",
                        )}
                      >
                        {latestAvailableIsSaved ? "Saved" : "Draft"}
                      </span>
                    </div>
                  ) : (
                    <span className="shrink-0 text-[13px] font-normal text-[#777777] dark:text-muted-foreground">
                      Add model
                    </span>
                  )}

                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                                className="inline-flex h-9 min-w-[12.5rem] max-w-full items-center gap-2 rounded-lg border border-[#E5E7EB] bg-white px-3 text-left text-[13px] font-medium text-foreground shadow-none hover:bg-[#fafafa] dark:border-border dark:bg-background dark:hover:bg-muted/40"
                              >
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                <span>Add Model</span>
                                <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
                                  <span className="flex h-5 min-w-[1.35rem] items-center justify-center rounded border border-[#e8e8e8] bg-[#f4f4f5] px-1 font-sans text-[10px] font-semibold leading-none text-foreground dark:border-border dark:bg-muted">
                                    {typeof navigator !== "undefined" &&
                                    navigator.platform.includes("Mac")
                                      ? "⌘"
                                      : "Ctrl"}
                                  </span>
                                  <span className="flex h-5 min-w-[1.35rem] items-center justify-center rounded border border-[#e8e8e8] bg-[#f4f4f5] px-1 font-sans text-[10px] font-semibold leading-none text-foreground dark:border-border dark:bg-muted">
                                    K
                                  </span>
                                </span>
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
                                  "flex h-8 shrink-0 items-center gap-0.5 rounded-lg border px-1.5",
                                  index === 0
                                    ? "border-[#e8c7b8] bg-[#fff8f5] dark:border-orange-200/35 dark:bg-orange-500/8"
                                    : "border-[#e0e0e0] bg-[#f5f5f5] dark:border-border dark:bg-muted/45",
                                )}
                              >
                                <div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#ebebeb] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-border dark:bg-background">
                                  <div className="flex scale-[1.2] items-center justify-center">
                                    <ProviderLogo
                                      provider={option?.provider ?? "custom"}
                                    />
                                  </div>
                                </div>
                                <span className="max-w-[9.5rem] truncate text-[13px] font-medium text-foreground">
                                  {label}
                                </span>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      className="rounded p-0.5 text-[#9e9e9e] hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
                                      aria-label={`Model options (${label})`}
                                    >
                                      <MoreVertical className="h-3.5 w-3.5" />
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
                                  className="rounded p-0.5 text-[#9e9e9e] hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
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
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[#e0e0e0] bg-white text-foreground hover:bg-[#fafafa] dark:border-border dark:bg-background dark:hover:bg-muted/50"
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

            <div className="space-y-4 border-t border-border/60 pt-4">
              <div className="space-y-3">
                {editForm && editForm.promptTurns.length === 1 ? (
                  <>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">
                        User prompt
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        The exact prompt or interaction to begin the test.
                      </p>
                      <Textarea
                        value={editForm.promptTurns[0]?.prompt ?? ""}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                          updatePromptTurn(0, (currentTurn) => ({
                            ...currentTurn,
                            prompt: event.target.value,
                          }))
                        }
                        rows={5}
                        placeholder="Enter the user prompt…"
                        aria-invalid={isStepPromptEmpty(editForm.promptTurns[0])}
                        aria-describedby={
                          isStepPromptEmpty(editForm.promptTurns[0])
                            ? "prompt-turn-0-hint"
                            : undefined
                        }
                        className={cn(
                          "mt-1.5 resize-none bg-muted/30 font-mono text-sm",
                          isStepPromptEmpty(editForm.promptTurns[0]) &&
                            evalValidationBorderClass,
                        )}
                      />
                      {isStepPromptEmpty(editForm.promptTurns[0]) ? (
                        <p
                          id="prompt-turn-0-hint"
                          className="mt-1 text-xs text-muted-foreground"
                        >
                          Required before run or save.
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">
                        Tool triggered
                      </Label>
                      <p className="mb-1.5 text-xs text-muted-foreground">
                        Which tools should be called for this step? Leave empty if the
                        model should not call any tools.
                      </p>
                      <ExpectedToolsEditor
                        toolCalls={
                          editForm.promptTurns[0]?.expectedToolCalls ?? []
                        }
                        onChange={(toolCalls) =>
                          updatePromptTurn(0, (currentTurn) => ({
                            ...currentTurn,
                            expectedToolCalls: toolCalls,
                          }))
                        }
                        availableTools={availableTools}
                      />
                      {stepExpectedToolsNeedAttention(editForm.promptTurns[0]) ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Finish tool names and arguments, or remove incomplete
                          rows.
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-0 text-xs text-muted-foreground"
                      onClick={addPromptTurn}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      Add another step
                    </Button>
                  </>
                ) : editForm ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs font-medium text-muted-foreground">
                        Prompt steps
                      </Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={addPromptTurn}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add step
                      </Button>
                    </div>
                    {editForm?.promptTurns.map((turn, index) => {
                      const isExpanded = expandedPromptTurnIds.includes(turn.id);
                      const promptEmpty = isStepPromptEmpty(turn);
                      const toolsAttention = stepExpectedToolsNeedAttention(turn);
                      const stepNeedsAttention = promptEmpty || toolsAttention;
                      return (
                        <div
                          key={turn.id}
                          className={cn(
                            "rounded-lg border bg-background/40",
                            stepNeedsAttention && !isExpanded
                              ? "border-destructive/40 dark:border-destructive/50"
                              : "border-border/50",
                          )}
                        >
                          <div className="flex items-center gap-2 px-3 py-2">
                            <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">
                              Step {index + 1}
                            </span>
                            <button
                              type="button"
                              className={cn(
                                "min-w-0 flex-1 truncate text-left text-xs text-muted-foreground",
                                promptEmpty && "text-destructive",
                              )}
                              onClick={() => togglePromptTurnExpanded(turn.id)}
                            >
                              {formatPromptPreview(turn.prompt) || "Empty prompt"}
                            </button>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={index === 0}
                                onClick={() => movePromptTurn(index, -1)}
                              >
                                <ArrowUp className="h-3 w-3" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={index === editForm.promptTurns.length - 1}
                                onClick={() => movePromptTurn(index, 1)}
                              >
                                <ArrowDown className="h-3 w-3" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                disabled={editForm.promptTurns.length <= 1}
                                onClick={() => removePromptTurn(index)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => togglePromptTurnExpanded(turn.id)}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          </div>
                          {isExpanded ? (
                            <div className="space-y-3 border-t border-border/50 px-3 py-3">
                              <div>
                                <Label className="text-xs font-medium text-muted-foreground">
                                  User prompt
                                </Label>
                                <Textarea
                                  value={turn.prompt}
                                  onChange={(
                                    event: ChangeEvent<HTMLTextAreaElement>,
                                  ) =>
                                    updatePromptTurn(index, (currentTurn) => ({
                                      ...currentTurn,
                                      prompt: event.target.value,
                                    }))
                                  }
                                  rows={4}
                                  placeholder={`Prompt for step ${index + 1}…`}
                                  aria-invalid={promptEmpty}
                                  aria-describedby={
                                    promptEmpty
                                      ? `prompt-turn-${index}-hint`
                                      : undefined
                                  }
                                  className={cn(
                                    "mt-1.5 resize-none bg-background font-mono text-sm",
                                    promptEmpty && evalValidationBorderClass,
                                  )}
                                />
                                {promptEmpty ? (
                                  <p
                                    id={`prompt-turn-${index}-hint`}
                                    className="mt-1 text-xs text-muted-foreground"
                                  >
                                    Required before run or save.
                                  </p>
                                ) : null}
                              </div>
                              <div>
                                <Label className="text-xs font-medium text-muted-foreground">
                                  Tool triggered
                                </Label>
                                <p className="mb-1.5 text-[11px] text-muted-foreground">
                                  Leave empty for an informational-only step, or leave
                                  every step empty to expect no tools for the whole
                                  case.
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
                                {toolsAttention ? (
                                  <p className="mt-1.5 text-xs text-muted-foreground">
                                    Finish tool names and arguments, or remove
                                    incomplete rows.
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </>
                ) : null}
              </div>
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
