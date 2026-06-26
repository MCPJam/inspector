import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import posthog from "posthog-js";
import {
  Circle,
  Code2,
  Loader2,
  Play,
  RotateCw,
  Save,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { listEvalTools, streamEvalTestCase } from "@/lib/apis/evals-api";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { StepListEditor } from "./step-list-editor";
import {
  CasePreviewPane,
  type CasePreviewTab,
} from "./preview/case-preview-pane";
import { PreviewHeaderSlot } from "./preview/preview-header-slot";
import {
  shouldSaveLiveRecorderStep,
  type RecorderProps,
  type RecorderReadyEvent,
  type RecorderStepEvent,
} from "@/components/chat-v2/thread/recorder-types";
import type { ScriptedStep, StepAssertion } from "@/shared/scripted-steps";
import { AssertPickChooser, type AssertPick } from "./assert-pick-chooser";
import { CaseRunsHistory } from "./runs/case-runs-history";
import { ReplayedScenarioPane } from "./runs/replayed-scenario-pane";
import { IterationDetails } from "./iteration-details";
import { resolveIterationJudge } from "./goal-completion-presentation";
import { CompareRunChatSurface } from "./compare-run-chat-surface";
import { EvalTraceSurface } from "./eval-trace-surface";
import {
  ModelCompareCardHeader,
  type MultiModelCardSummary,
} from "@/components/chat-v2/model-compare-card-header";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { ModelDefinition } from "@/shared/types";
import type { RemoteServer } from "@/hooks/useProjects";
import {
  buildTestCaseModelOptions,
  getPersistedTestCaseModelValue,
  prepareSingleTestCaseRun,
  resolveSelectedTestCaseModelValue,
  setPersistedTestCaseModelValue,
} from "./single-test-case-runner";
import {
  resolvePromptTurnsWithLegacyProbe,
  stripPromptTurnsFromAdvancedConfig,
} from "@/shared/steps";
import { PROBE_TOOL_NAME_PLACEHOLDER } from "@/shared/probe-config";
import {
  deriveExpectedToolCalls,
  deriveQuery,
  isAssertStep,
  isModelFree,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  normalizeSteps,
  promptTurnsToSteps,
  resolveDisplayExpectedToolCalls,
  stepAssertionToWidgetAssertion,
  stepsToPromptTurns,
  stepTurnIndices,
  type InteractAction,
  type TestStep,
  type ToolCallStep,
} from "@/shared/steps";
import { appendScenarioPredicatesAsAssertSteps } from "@/shared/predicate-migration";

/**
 * Seed the editor's `editForm.steps` from a test case. The backend stores
 * `steps` natively; prefer them directly. Old `widget_probe`/pre-steps blobs
 * (no `steps`) are bridged once through the legacy resolver — the ONE remaining
 * use of the prompt-turns adapter on the load path, deletable in Phase E once
 * no un-migrated rows remain.
 */
function loadSteps(testCase: unknown): TestStep[] {
  const steps = (testCase as { steps?: unknown })?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    return normalizeSteps(steps);
  }
  return promptTurnsToSteps(
    resolvePromptTurnsWithLegacyProbe(
      testCase as Parameters<typeof resolvePromptTurnsWithLegacyProbe>[0],
    ),
  );
}
import { normalizeToolChoice } from "@/shared/tool-choice";
import {
  resolveMatchOptions,
  type EvalMatchOptions,
  type CasePredicates,
  type Predicate,
} from "@/shared/eval-matching";
import { areAllChecksValid } from "./checks-section";
import { CasePassCriteriaPopover } from "./case-pass-criteria-section";
import {
  DEFAULT_HOST_STYLE_V2,
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { cn } from "@/lib/utils";
import {
  getEffectiveSuiteServers,
  getSelectedSuiteHostRunPlan,
} from "./helpers";
import { parseDraftTestCaseId } from "./draft-test-case";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { computeIterationResult } from "./pass-criteria";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import {
  buildHistoricalCompareRunRecords,
  buildComparePreviewTrace,
  buildSpecPreviewTrace,
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
  EvalSuiteRun,
  RunColumnTab,
} from "./types";
import type { EvalExportDraftInput } from "@/lib/evals/eval-export";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import { buildCaseChatHandoff } from "@/lib/eval-chat-handoff";
import { EvalLiveChatPanel } from "./eval-live-chat-panel";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import { formatMcpConnectServerPrompt } from "@/lib/mcp-server-display-name";
import {
  formatEnsureServersReadyError,
  hasUnavailableServers,
  normalizeSuiteServerRefs,
} from "./use-eval-handlers";
import { useConvexAccessToken } from "@/hooks/use-convex-access-token";
import {
  reduceEvalStreamEvent,
  initialEvalStreamState,
  mergeStreamingTrace,
} from "./eval-stream-reducer";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import { TraceViewer } from "./trace-viewer";
import { useEvalTraceToolContext } from "./use-eval-trace-tool-context";
import { useEvalTraceBlob } from "./use-eval-trace-blob";
import {
  deriveRenderedWidgetTargets,
  type RenderedWidgetTarget,
} from "./rendered-widget-targets";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
} from "./trace-viewer-adapter";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
  getChatboxShellStyle,
  normalizeChatboxHostStyleId,
  resolveHostLogoByDisplayName,
} from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface TestTemplate {
  title: string;
  runs: number;
  scenario?: string;
  steps: TestStep[];
  advancedConfig?: Record<string, unknown>;
  matchOptions?: EvalMatchOptions;
  /** Case-level predicate gate override; undefined ⇒ inherit suite defaults. */
  predicates?: CasePredicates;
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
  connectedServerNames: Set<string>;
  projectId: string | null;
  availableModels: ModelDefinition[];
  /**
   * Iterations for the entire suite, already subscribed by the parent via
   * `getAllTestCasesAndIterationsBySuite`. We filter to the current case
   * locally instead of opening a second `listTestIterations` subscription
   * for data the parent already has — one reactive subscription instead
   * of two, and no spinner when the user drills into the Runs tab.
   */
  suiteIterations: EvalIteration[];
  /**
   * Suite runs for the current suite — used by the Runs tab to show which
   * host produced each batch (via `namedHostId` on suite runs).
   */
  suiteRuns?: EvalSuiteRun[];
  onExportDraft?: (draft: EvalExportDraftInput) => void;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  /** Route-driven tab switch. Editor reflects {@link openCompareFromRoute} after the URL changes. */
  onSelectTab?: (tab: "edit" | "runs") => void;
  /** Deep link: open compare run surface once iteration data is ready (same as the Runs tab). */
  openCompareFromRoute?: boolean;
  /** Deep link: exact iteration to anchor compare hydration to. */
  openCompareIterationId?: string | null;
  /**
   * When true, this is rendering the direct-guest eval playground flow.
   * Guests still use the inline runner for direct server access, but the saved
   * suite/case/iteration state lives in Convex.
   */
  isDirectGuest?: boolean;
  /** When set, Run will call this to connect suite MCP servers before starting (playground / desktop). */
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  projectServers?: RemoteServer[];
  /**
   * Called after an unsaved draft case is persisted for the first time, with the
   * new Convex id, so the parent can swap the `draft:<kind>` route for the real
   * one. Only relevant when `selectedTestCaseId` is a draft sentinel.
   */
  onDraftSaved?: (newTestCaseId: string) => void;
}

function recorderDebug(message: string, details?: Record<string, unknown>) {
  try {
    if (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("mcpjam:recorder-debug") === "1"
    ) {
      console.info(`[recorder] ${message}`, details ?? {});
    }
  } catch {
    // best-effort debug logging only
  }
}

/**
 * Segmented "what does clicking the widget do" toggle, shown once a widget is
 * armed: Record actions (replayable interaction steps) vs Add checks (click an
 * element → assert chooser). Shared by both arm-bar render sites.
 */
function CaptureModeToggle({
  mode,
  onChange,
}: {
  mode: "record" | "assert";
  onChange: (mode: "record" | "assert") => void;
}) {
  const options: { value: "record" | "assert"; label: string }[] = [
    { value: "record", label: "Record actions" },
    { value: "assert", label: "Add checks" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            data-testid={`capture-mode-${opt.value}`}
            onClick={() => onChange(opt.value)}
            className={
              "px-2 py-0.5 text-[11px] font-medium transition " +
              (active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * In-memory shape for an unsaved ("draft") case, so the editor can render it
 * before anything is written to Convex. Mirrors the fields the old eager-create
 * handlers inserted. `_id` is the route sentinel (`draft:<kind>`), not a real
 * Convex id — Save swaps the eager update for a `createTestCase` insert.
 */
function buildDraftTestCase(
  id: string,
  suiteTestCases: any[] | undefined,
): any {
  const collected = collectUniqueModelsFromTestCases(suiteTestCases ?? []);
  const models =
    collected.length > 0
      ? collected
      : [{ provider: "anthropic", model: "anthropic/claude-haiku-4.5" }];
  return {
    _id: id,
    title: "Untitled test case",
    query: "",
    runs: 1,
    models,
    caseType: "prompt",
  };
}

// Monotonic id for recorder-appended widget steps (interact/assert). Mirrors
// the StepListEditor's scheme so appended rows get a stable React key.
let widgetStepIdCounter = 0;
function newWidgetStepId(kind: string): string {
  widgetStepIdCounter += 1;
  return `${kind}-${Date.now()}-${widgetStepIdCounter}`;
}

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

/**
 * An implicit "turn" derived from the flat step list — the SAME grouping the
 * runner/`stepTurnIndices` use: a `prompt`/`toolCall` step opens a turn and
 * following `assert` steps fold into it. Captures only what step-level
 * validation needs (the primary action + its `toolCalledWith` expectations).
 * A leading assert with no open turn opens a synthetic model turn (mirrors the
 * runner's `ensureTurn`).
 */
type StepTurn = {
  primaryKind: "prompt" | "toolCall";
  promptText: string;
  toolCall: ToolCallStep | null;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
};

function groupStepsIntoTurns(steps: TestStep[]): StepTurn[] {
  const turns: StepTurn[] = [];
  let current: StepTurn | null = null;
  const ensure = (): StepTurn => {
    if (!current) {
      current = {
        primaryKind: "prompt",
        promptText: "",
        toolCall: null,
        expectedToolCalls: [],
      };
      turns.push(current);
    }
    return current;
  };
  for (const step of steps) {
    if (isPromptStep(step)) {
      current = {
        primaryKind: "prompt",
        promptText: step.prompt,
        toolCall: null,
        expectedToolCalls: [],
      };
      turns.push(current);
    } else if (isToolCallStep(step)) {
      current = {
        primaryKind: "toolCall",
        promptText: "",
        toolCall: step,
        expectedToolCalls: [],
      };
      turns.push(current);
    } else if (isAssertStep(step)) {
      const a = step.assertion;
      if (!isWidgetAssertion(a) && a.type === "toolCalledWith") {
        ensure().expectedToolCalls.push({
          toolName: a.toolName,
          arguments: a.args.args ?? {},
        });
      }
    }
  }
  return turns;
}

/**
 * A negative test = the MODEL is expected to call no tools. Model-free
 * (`toolCall`) turns always carry no expectations, so consider only `prompt`
 * turns — otherwise a case containing a pinned render check would be mislabeled
 * negative. A case with no model (`prompt`) turns is not a negative test.
 */
function deriveIsNegativeTestFromSteps(steps: TestStep[]): boolean {
  const modelTurns = groupStepsIntoTurns(steps).filter(
    (t) => t.primaryKind === "prompt",
  );
  return (
    modelTurns.length > 0 &&
    modelTurns.every((t) => t.expectedToolCalls.length === 0)
  );
}

/** A `toolCall` step needs a server and a real (non-placeholder) tool. */
function isToolCallStepIncomplete(step: ToolCallStep): boolean {
  return (
    !step.serverName?.trim() ||
    !step.toolName?.trim() ||
    step.toolName === PROBE_TOOL_NAME_PLACEHOLDER
  );
}

const validateSteps = (steps: TestStep[]): boolean => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return false;
  }

  // Each primary step must be complete: prompts need text, tool calls need a
  // server + real tool.
  for (const step of steps) {
    if (isPromptStep(step)) {
      if (!step.prompt.trim()) return false;
    } else if (isToolCallStep(step)) {
      if (isToolCallStepIncomplete(step)) return false;
    }
  }

  // Negative/asserted-tool logic applies only to model (`prompt`) turns.
  const modelTurns = groupStepsIntoTurns(steps).filter(
    (t) => t.primaryKind === "prompt",
  );
  if (modelTurns.length === 0) {
    // Tool-call-only case (render check): all primaries validated above.
    return true;
  }

  if (deriveIsNegativeTestFromSteps(steps)) {
    return true;
  }

  const assertedTurns = modelTurns.filter(
    (t) => t.expectedToolCalls.length > 0,
  );
  if (assertedTurns.length === 0) {
    return false;
  }

  return assertedTurns.every((t) =>
    validateExpectedToolCalls(t.expectedToolCalls),
  );
};

/** Short message when Run/Save are blocked by prompt or expected-tool validation. */
export function getStepsBlockReason(steps: TestStep[]): string | null {
  if (!Array.isArray(steps) || steps.length === 0) {
    return "Configure at least one prompt step.";
  }

  const turns = groupStepsIntoTurns(steps);

  const incompleteToolCalls = turns
    .map((t, i) =>
      t.primaryKind === "toolCall" &&
      t.toolCall &&
      isToolCallStepIncomplete(t.toolCall)
        ? i + 1
        : null,
    )
    .filter((n): n is number => n !== null);
  if (incompleteToolCalls.length > 0) {
    return turns.length === 1
      ? "Pick a server and tool for the render check."
      : `Pick a server and tool for render-check turn(s) ${incompleteToolCalls.join(
          ", ",
        )}.`;
  }

  const emptySteps = turns
    .map((t, i) =>
      t.primaryKind === "prompt" && !t.promptText.trim() ? i + 1 : null,
    )
    .filter((n): n is number => n !== null);

  if (emptySteps.length > 0) {
    if (turns.length === 1) {
      return "Enter a user prompt before run or save.";
    }
    return `Enter a user prompt for step(s) ${emptySteps.join(", ")}.`;
  }

  if (validateSteps(steps)) {
    return null;
  }

  return "Finish tool names and arguments, or remove incomplete expected tools.";
}

export function getPromptTurnBlockReason(
  promptTurns: Parameters<typeof promptTurnsToSteps>[0],
): string | null {
  return getStepsBlockReason(promptTurnsToSteps(promptTurns));
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
      .reduce((acc, key) => {
        acc[key] = normalizeForComparison(value[key]);
        return acc;
      }, {} as Record<string, any>);
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

type CaseEditorTab = "edit" | "runs";

/** Underline Edit / Runs section nav: drives the URL via onSelect; mirrors the last-run status as a dot on Runs. */
function CaseEditorTabs({
  active,
  onSelect,
  runsDotClass,
  runsAriaLabel,
}: {
  active: CaseEditorTab;
  onSelect: (tab: CaseEditorTab) => void;
  /** When provided, shown to the left of the Runs label. */
  runsDotClass?: string;
  runsAriaLabel?: string;
}) {
  const baseClass =
    "inline-flex h-9 items-center gap-1.5 -mb-px border-b-2 px-1 text-sm font-medium transition-colors";
  const inactiveClass =
    "border-transparent text-muted-foreground hover:text-foreground";
  const activeClass = "border-foreground text-foreground";
  return (
    <div
      role="tablist"
      aria-label="Case view"
      className="flex items-center gap-6 border-b border-border/60"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "edit"}
        className={cn(
          baseClass,
          active === "edit" ? activeClass : inactiveClass,
        )}
        onClick={() => onSelect("edit")}
      >
        Edit
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "runs"}
        aria-label={runsAriaLabel}
        className={cn(
          baseClass,
          active === "runs" ? activeClass : inactiveClass,
        )}
        onClick={() => onSelect("runs")}
      >
        Runs
        {runsDotClass ? <span className={runsDotClass} aria-hidden /> : null}
      </button>
    </div>
  );
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
  connectedServerNames,
  projectId,
  availableModels,
  suiteIterations,
  suiteRuns = [],
  onExportDraft,
  onContinueInChat,
  onSelectTab,
  openCompareFromRoute = false,
  openCompareIterationId = null,
  isDirectGuest = false,
  ensureServersReady,
  projectServers,
  onDraftSaved,
}: TestTemplateEditorProps) {
  // Resolves the WorkOS token for signed-in users and the guest bearer for
  // guests (project-owning guests included). See use-convex-access-token.
  const getAccessToken = useConvexAccessToken();
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  // Guards the first-Save insert of a prompt draft so a double-click can't
  // create the case twice while createTestCase is in flight.
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(
    openCompareFromRoute ? "run" : "config",
  );
  const [availableTools, setAvailableTools] = useState<
    Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId?: string;
      _meta?: Record<string, unknown>;
    }>
  >([]);
  const [selectedModelValues, setSelectedModelValues] = useState<string[]>([]);
  const [compareRunRecords, setCompareRunRecords] = useState<
    Record<string, CompareRunRecord>
  >({});
  // The single in-flight run whose per-step ticks drive the shared left-pane step
  // cards. Scope to the RUNNING record — NOT the whole `compareRunRecords` map,
  // which retains a record for every selected model + completed prior runs (so a
  // lone quick-run with other models selected would otherwise never tick). True
  // compare mode (2+ running columns) stays ambiguous → skipped; a single settled
  // record still feeds the final per-step verdicts.
  const liveStatusRecord = useMemo(() => {
    const records = Object.values(compareRunRecords);
    const running = records.filter((r) => r.status === "running");
    if (running.length === 1) return running[0];
    if (running.length > 1) return undefined;
    return records.length === 1 ? records[0] : undefined;
  }, [compareRunRecords]);
  // Live per-turn status (turn-derived fallback).
  const liveStepStatusByTurn = useMemo<
    Map<number, EvalStepStatus> | undefined
  >(() => {
    const status = liveStatusRecord?.streamingStepStatus;
    if (!status) return undefined;
    const map = new Map<number, EvalStepStatus>();
    for (const entry of Object.values(status)) {
      map.set(entry.turnIndex, entry.status);
    }
    return map.size > 0 ? map : undefined;
  }, [liveStatusRecord]);
  // PR5: per-step status keyed by stepId (present once the step engine emits
  // per-step `step_status`). Takes precedence over the turn-derived map above.
  const liveStepStatusById = useMemo<Map<string, EvalStepStatus> | undefined>(() => {
    const status = liveStatusRecord?.streamingStepStatus;
    if (!status) return undefined;
    const map = new Map<string, EvalStepStatus>();
    for (const entry of Object.values(status)) {
      if (entry.stepId) map.set(entry.stepId, entry.status);
    }
    return map.size > 0 ? map : undefined;
  }, [liveStatusRecord]);
  const [routeCompareAnchorIterationId, setRouteCompareAnchorIterationId] =
    useState<string | null>(openCompareIterationId);
  const [activeCompareRunId, setActiveCompareRunId] = useState<string | null>(
    null,
  );
  const [runColumnTabByModel, setRunColumnTabByModel] = useState<
    Record<string, RunColumnTab>
  >({});
  // Left↔right Steps sync: the step hovered in either the left step list or the
  // right replay pane; highlights the matching card/row in both.
  const [syncedStepId, setSyncedStepId] = useState<string | null>(null);
  const [mobileVisibleModelValue, setMobileVisibleModelValue] = useState<
    string | null
  >(null);
  const [isRunningCompare, setIsRunningCompare] = useState(false);
  /**
   * Transient per-run iteration count (1-10). Applies to the next Run
   * triggered from this editor; does NOT mutate the persisted
   * `EvalCase.runs` default. Mirrors the suite-header picker.
   */
  const [iterationOverride, setIterationOverride] = useState<number>(1);
  const [quickRunHostSelection, setQuickRunHostSelection] = useState<
    string | null
  >(null);
  // Right-pane toggle for the split edit layout: the forming-conversation
  // Preview vs. this case's run history (Runs).
  const [previewTab, setPreviewTab] = useState<CasePreviewTab>("preview");
  // When a run is in flight / just finished, the Preview pane shows that run's
  // live conversation instead of the synthetic spec. `lastRunModelValue` pins
  // which model's record to show; `showSpecOverride` lets the user flip back to
  // the spec without re-editing.
  const [lastRunModelValue, setLastRunModelValue] = useState<string | null>(
    null,
  );
  const [showSpecOverride, setShowSpecOverride] = useState<boolean>(false);
  // Record mode: swap the Preview pane to a LIVE, auto-connected playground
  // (EvalLiveChatPanel) so the user clicks live widgets instead of viewing a
  // frozen trace. No grading — the eval runner is out of this path. Past-run
  // review (`replayIteration`) still wins, so opening a run shows its trace.
  const [liveRecordMode, setLiveRecordMode] = useState<boolean>(false);
  // A past iteration selected from the Runs tab to replay in the Preview pane.
  const [replayIteration, setReplayIteration] = useState<EvalIteration | null>(
    null,
  );
  // What a click inside a live widget does: "record" appends an interaction step;
  // "assert" captures the clicked element's locator and opens the assert chooser
  // instead. The ref mirror lets the stable `handleRecorderStep` callback read
  // the mode without re-subscribing.
  const [captureMode, setCaptureMode] = useState<"record" | "assert">("record");
  const captureModeRef = useRef<"record" | "assert">("record");
  useEffect(() => {
    captureModeRef.current = captureMode;
  }, [captureMode]);
  // A pending assert-mode pick: the element the user clicked, awaiting a choice
  // of what to check. Null when the chooser is closed.
  const [pendingPick, setPendingPick] = useState<AssertPick | null>(null);
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
  // The route-anchor iteration id we've already opened as a replay. Guards the
  // deep-link effect so it opens the snapshot once per anchor — without it,
  // "Back to editing" would immediately snap back into the replay.
  const appliedReplayAnchorRef = useRef<string | null>(null);
  const updateTestCaseMutation = useMutation(
    "testSuites:updateTestCase" as any,
  ) as unknown as (args: {
    testCaseId: string;
    [key: string]: unknown;
  }) => Promise<unknown>;
  const createTestCaseMutation = useMutation(
    "testSuites:createTestCase" as any,
  ) as unknown as (args: Record<string, unknown>) => Promise<string>;

  // A draft (`draft:<kind>` sentinel) is a brand-new case the user is
  // configuring but has not saved. It is NOT in Convex yet, so we synthesize it
  // locally and only persist on Save. See ./draft-test-case.ts.
  const draftKind = parseDraftTestCaseId(selectedTestCaseId);
  const isDraft = draftKind !== null;

  const testCases = useQuery("testSuites:listTestCases" as any, {
    suiteId,
  }) as any[] | undefined;

  const currentTestCase = useMemo(() => {
    if (draftKind) {
      return buildDraftTestCase(selectedTestCaseId, testCases);
    }
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [draftKind, testCases, selectedTestCaseId]);

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

  // Iterations for the currently-selected case, filtered from the suite-wide
  // list the parent already subscribes to. Cap matches the old per-case
  // `listTestIterations({ limit: 200 })` so downstream consumers see the same
  // bounded slice they did before.
  const recentIterations = useMemo<EvalIteration[]>(() => {
    if (!selectedTestCaseId) return [];
    return suiteIterations
      .filter((iteration) => iteration.testCaseId === selectedTestCaseId)
      .slice(0, 200);
  }, [suiteIterations, selectedTestCaseId]);

  const suite = useQuery("testSuites:getTestSuite" as any, { suiteId }) as any;

  /**
   * Suite-level hostConfig (v2). The same query SuiteExecutionConfigEditor
   * uses — single source of truth for model / system / temperature /
   * hostContext / capabilities / style at the suite level.
   */
  const suiteHostConfigDto = useQuery(
    "hostConfigsV2:getSuiteConfig" as any,
    { suiteId } as any,
  ) as HostConfigDtoV2 | null | undefined;

  /**
   * Editable shape derived from the suite DTO. When the suite has no v2 row
   * yet, seed from the legacy `suite.defaultConfig.{modelId,systemPrompt,
   * temperature}` mirror so the header isn't blank on suites that pre-date
   * the v2 schema. Mirrors `SuiteExecutionConfigEditor` line 97-107.
   */
  const hostConfigBaseline = useMemo<HostConfigInputV2 | null>(() => {
    if (suiteHostConfigDto === undefined) return null; // still loading
    if (suiteHostConfigDto) return hostConfigDtoToInput(suiteHostConfigDto);
    return emptyHostConfigInputV2({
      modelId: suite?.defaultConfig?.modelId,
      systemPrompt: suite?.defaultConfig?.systemPrompt,
      temperature: suite?.defaultConfig?.temperature,
    });
  }, [
    suiteHostConfigDto,
    suite?.defaultConfig?.modelId,
    suite?.defaultConfig?.systemPrompt,
    suite?.defaultConfig?.temperature,
  ]);

  useEffect(() => {
    setEditorMode(openCompareFromRoute ? "run" : "config");
  }, [openCompareFromRoute]);

  useEffect(() => {
    setCompareRunRecords({});
    setActiveCompareRunId(null);
    setRunColumnTabByModel({});
    setMobileVisibleModelValue(null);
    initializedSelectionCaseRef.current = null;
    appliedReplayAnchorRef.current = null;
    setReplayIteration(null);
  }, [selectedTestCaseId]);

  useEffect(() => {
    setRouteCompareAnchorIterationId(openCompareIterationId);
  }, [openCompareIterationId, selectedTestCaseId]);

  // Deep link from the results matrix: a cell carries a (case, run) iteration
  // id via the `iteration` route param. When it isn't the legacy compare path
  // (`openCompareFromRoute`), open that iteration as a replay so the editor
  // shows the case "as it ran" — the snapshot pane + replayed conversation —
  // instead of the live case. Applied once per anchor so "Back to editing"
  // sticks.
  useEffect(() => {
    if (openCompareFromRoute) return;
    const anchorId = routeCompareAnchorIterationId;
    if (!anchorId || appliedReplayAnchorRef.current === anchorId) return;
    if (routeCompareAnchorIteration == null) return; // still loading / not found
    appliedReplayAnchorRef.current = anchorId;
    setReplayIteration(routeCompareAnchorIteration);
    setShowSpecOverride(false);
    setPreviewTab("preview");
  }, [
    openCompareFromRoute,
    routeCompareAnchorIterationId,
    routeCompareAnchorIteration,
  ]);

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
      // Keep `streamingStepStatus`: once the persisted trace loads, the RunColumn
      // switches to it, but the per-step ok/fail/skipped map must STAY so the
      // left-pane step cards keep showing the last run's verdicts (which step
      // failed). It's reset to a fresh record at the next run's start.
      return { ...previous, [modelValue]: rest };
    });
  }, []);

  useEffect(() => {
    if (!currentTestCase) {
      return;
    }

    // Legacy `widget_probe` rows store the pinned call as top-level
    // `probeConfig` (not a turn); surface it as a pinned turn so it edits in
    // the unified editor like any render-check turn. Shared with the runner's
    // `normalizeTestForPinnedTurns` so the rule lives in one place. No-op for
    // post-migration rows that already carry the pinned turn.
    const steps = loadSteps(currentTestCase);
    setEditForm({
      title: currentTestCase.title,
      runs: currentTestCase.runs,
      scenario: currentTestCase.scenario ?? "",
      steps,
      advancedConfig: normalizeAdvancedConfig(currentTestCase.advancedConfig),
      matchOptions: currentTestCase.matchOptions,
      predicates: currentTestCase.predicates,
    });
    // Seed the transient picker from the persisted runs so a user who saved
    // runs=N still sees N selected when the editor opens. Clamp to [1, 10]
    // — the picker only exposes that range.
    setIterationOverride(Math.max(1, Math.min(10, currentTestCase.runs ?? 1)));
  }, [currentTestCase?._id]);

  /**
   * Effective server list for the suite — legacy `environment.servers`
   * merged with `hostAttachments[*].resolvedServerNames`. All run / tool
   * gates downstream consult this; reading `suite.environment.servers`
   * directly here would treat attachment-only suites (the current model)
   * as having no servers and disable Run / hide tool autocomplete.
   */
  const effectiveSuiteServers = useMemo(
    () => (suite ? getEffectiveSuiteServers(suite) : []),
    [suite],
  );

  // Quick Run never runs hostless: when the suite has attached hosts the
  // picker lists ONLY those (no "Suite default" — that pseudo-host mapped to a
  // null host context). Attachment-less suites run under the suite's own host
  // config, surfaced read-only below rather than as a selectable option.
  const quickRunHostOptions = useMemo<
    Array<{ value: string; label: string; namedHostId: string }>
  >(() => {
    const attachments = suite?.hostAttachments ?? [];
    return attachments.map(
      (attachment: NonNullable<typeof suite>["hostAttachments"][number]) => ({
        value: attachment.namedHostId,
        label: attachment.hostName ?? attachment.namedHostId,
        namedHostId: attachment.namedHostId,
      }),
    );
  }, [suite?.hostAttachments]);

  useEffect(() => {
    setQuickRunHostSelection((current) => {
      const validValues = new Set(
        quickRunHostOptions.map((option) => option.value),
      );
      if (current && validValues.has(current)) {
        return current;
      }
      // Always preselect the first attached host; null only when there are no
      // attachments (the read-only suite-host chip renders in that case).
      return quickRunHostOptions[0]?.value ?? null;
    });
  }, [quickRunHostOptions]);

  // The host a replayed iteration actually ran on (its suite run's
  // `namedHostId`) — i.e. the matrix column the user clicked to open it.
  const replayHostId = useMemo(() => {
    const runId = replayIteration?.suiteRunId;
    if (!runId) return undefined;
    return suiteRuns.find((run) => run._id === runId)?.namedHostId;
  }, [replayIteration, suiteRuns]);

  // When viewing a past iteration, point Quick Run at the host THAT iteration
  // ran on, so a Retry / Quick Run targets the same host (e.g. the ChatGPT
  // column you clicked) instead of falling back to the suite's first
  // attachment. Fires only when the replayed iteration changes, so a manual
  // host change afterward is preserved. Declared after the preselect effect so
  // it wins on mount when both run.
  useEffect(() => {
    if (!replayHostId) return;
    if (quickRunHostOptions.some((option) => option.value === replayHostId)) {
      setQuickRunHostSelection(replayHostId);
    }
  }, [replayHostId, quickRunHostOptions]);

  const selectedQuickRunHostId = quickRunHostSelection ?? undefined;
  const quickRunHostPlan = useMemo(
    () =>
      suite
        ? getSelectedSuiteHostRunPlan(suite, selectedQuickRunHostId)
        : {
            namedHostId: undefined,
            hostName: null,
            serverIds: effectiveSuiteServers,
          },
    [effectiveSuiteServers, selectedQuickRunHostId, suite],
  );
  const quickRunSuiteServers = quickRunHostPlan.serverIds;
  const selectedQuickRunHostOption =
    quickRunHostOptions.find(
      (option) => option.value === quickRunHostSelection,
    ) ?? quickRunHostOptions[0];
  const selectedQuickRunHostLogoSrc =
    selectedQuickRunHostOption?.namedHostId != null
      ? resolveHostLogoByDisplayName(selectedQuickRunHostOption.label)
      : null;
  // Effective host for an attachment-less suite — its own configured host
  // style, defaulting to MCPJam. Mirrors the server's `loadSuiteHostConfig`
  // default so the chip names the host the run actually uses.
  const suiteHostStyle =
    normalizeChatboxHostStyleId(hostConfigBaseline?.hostStyle) ??
    DEFAULT_HOST_STYLE_V2;
  const suiteHostLabel = getChatboxHostLabel(suiteHostStyle);
  const suiteHostLogoSrc = getChatboxHostLogo(suiteHostStyle);

  const hostNamesById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite?.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite?.hostAttachments]);
  const hasHostAttachments = (suite?.hostAttachments?.length ?? 0) > 0;

  const missingServers = useMemo(
    () =>
      quickRunSuiteServers.filter(
        (server: string) => !connectedServerNames.has(server),
      ),
    [quickRunSuiteServers, connectedServerNames],
  );
  const connectedSuiteServerKey = useMemo(
    () =>
      effectiveSuiteServers
        .filter((server: string) => connectedServerNames.has(server))
        .sort()
        .join("|"),
    [effectiveSuiteServers, connectedServerNames],
  );

  // Auto-connect the suite's MCP servers into the local pool when a saved case
  // is open and they aren't connected yet. Reuses the shared `ensureServersReady`
  // batch-connect (the same one the Run button and other surfaces use) so the
  // live Chat-tab widget replay can read from the local pool. Without this, a
  // fresh case/run renders the widget before the local connection exists and the
  // widget-content fetch 500s with "Unknown MCP server" until a manual reconnect
  // or navigate-out/in (which reconnects via `useEvalTraceToolContext`). The ref
  // keys on the server set so we attempt each disconnected set at most once
  // (avoids a connect loop while a connection is in flight or genuinely failing).
  const ensuredSuiteServersKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (isDraft || !ensureServersReady || effectiveSuiteServers.length === 0) {
      return;
    }
    const key = [...effectiveSuiteServers].sort().join("|");
    if (missingServers.length === 0) {
      ensuredSuiteServersKeyRef.current = key;
      return;
    }
    if (ensuredSuiteServersKeyRef.current === key) {
      return;
    }
    ensuredSuiteServersKeyRef.current = key;
    void ensureServersReady(effectiveSuiteServers);
  }, [
    isDraft,
    ensureServersReady,
    effectiveSuiteServers,
    missingServers.length,
  ]);

  const hasConfiguredSuiteServers = quickRunSuiteServers.length > 0;
  // Guests rely on the local persistent MCP manager; don't block Run on the
  // connected-servers check — the runner surfaces a connection error if the
  // server is genuinely missing.
  const canRun = isDirectGuest || hasConfiguredSuiteServers;

  useEffect(() => {
    let cancelled = false;

    async function fetchTools() {
      if (!suite) return;

      const serverIds = effectiveSuiteServers;
      if (serverIds.length === 0) {
        setAvailableTools([]);
        return;
      }

      try {
        const data = await listEvalTools({
          projectId,
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
  }, [suite, projectId, effectiveSuiteServers, connectedSuiteServerKey]);

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

  const currentSteps = useMemo(
    // Match how editForm.steps is seeded (legacy widget_probe → toolCall step)
    // so a freshly-opened legacy render check doesn't read as dirty.
    () => (currentTestCase ? loadSteps(currentTestCase) : []),
    [currentTestCase],
  );
  const currentAdvancedConfig = useMemo(
    () => normalizeAdvancedConfig(currentTestCase?.advancedConfig),
    [currentTestCase],
  );

  // True when today's case scenario differs from the snapshot of the run being
  // replayed — drives the "edited since this run" banner on the read-only
  // snapshot pane. Compares step content only (ids are volatile).
  const replaySnapshotEdited = useMemo(() => {
    const snapshot = replayIteration?.testCaseSnapshot;
    if (!snapshot) return false;
    const fingerprint = (steps: TestStep[]) =>
      JSON.stringify(
        normalizeForComparison(steps.map(({ id: _id, ...rest }) => rest)),
      );
    const snapshotSteps = loadSteps(snapshot);
    return fingerprint(snapshotSteps) !== fingerprint(currentSteps);
  }, [replayIteration, currentSteps]);

  const hasUnsavedChanges = useMemo(() => {
    if (!editForm || !currentTestCase) return false;

    const normalizedSteps = JSON.stringify(
      normalizeForComparison(editForm.steps),
    );
    const normalizedCurrentSteps = JSON.stringify(
      normalizeForComparison(currentSteps),
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
      deriveIsNegativeTestFromSteps(currentSteps);
    const serverNegativeFlagMismatch =
      (currentTestCase.isNegativeTest ?? false) !== effectiveNegativeOnServer;

    const normalizedMatchOptions = JSON.stringify(
      normalizeForComparison(editForm.matchOptions ?? null),
    );
    const normalizedCurrentMatchOptions = JSON.stringify(
      normalizeForComparison(currentTestCase.matchOptions ?? null),
    );
    const normalizedPredicates = JSON.stringify(
      normalizeForComparison(editForm.predicates ?? null),
    );
    const normalizedCurrentPredicates = JSON.stringify(
      normalizeForComparison(currentTestCase.predicates ?? null),
    );

    return (
      editForm.title !== currentTestCase.title ||
      editForm.runs !== currentTestCase.runs ||
      normalizedScenario !== normalizedCurrentScenario ||
      normalizedSteps !== normalizedCurrentSteps ||
      normalizedAdvancedConfig !== normalizedCurrentAdvancedConfig ||
      normalizedMatchOptions !== normalizedCurrentMatchOptions ||
      normalizedPredicates !== normalizedCurrentPredicates ||
      serverNegativeFlagMismatch
    );
  }, [editForm, currentAdvancedConfig, currentSteps, currentTestCase]);

  const arePromptTurnsValid = useMemo(() => {
    if (!editForm) return true;
    return validateSteps(editForm.steps);
  }, [editForm]);

  // A case whose every step is a model-free tool call needs no model — hide the
  // model picker and drop the "select a model" run gate for it.
  const casePinnedOnly = useMemo(
    () => (editForm ? isModelFree(editForm.steps) : false),
    [editForm],
  );
  const arePredicatesValid = useMemo(() => {
    if (!editForm?.predicates) return true;
    // In `inherit` mode the case's `list` is semantically ignored by the
    // runner — only suite defaults gate the run. The setMode("inherit")
    // handler preserves non-empty lists for UX convenience (so the user
    // can flip back to replace/extend without losing their work), which
    // means stale invalid rows from a previous mode are reachable. Don't
    // let those block the Save button.
    if (editForm.predicates.mode === "inherit") return true;
    return areAllChecksValid(editForm.predicates.list);
  }, [editForm?.predicates]);

  const savePrimaryDisabled =
    !arePromptTurnsValid ||
    !arePredicatesValid ||
    isRunningCompare ||
    isSavingDraft;

  const saveDisabledTooltip = useMemo(() => {
    if (!savePrimaryDisabled) {
      return null;
    }
    if (isRunningCompare) {
      return "Wait for the current run to finish before saving.";
    }
    if (!arePromptTurnsValid && editForm) {
      return getStepsBlockReason(editForm.steps);
    }
    if (!arePredicatesValid) {
      return "Fix invalid checks before saving.";
    }
    return null;
  }, [
    savePrimaryDisabled,
    isRunningCompare,
    arePromptTurnsValid,
    arePredicatesValid,
    editForm,
  ]);

  const runPrimaryDisabled =
    isDraft ||
    // A model-free render check has no editor quick-run path — it runs with the
    // full suite (the compare path below would abort on "no model"). Disable
    // Run for it with an explanatory tooltip instead of letting it fail.
    casePinnedOnly ||
    selectedModelValues.length === 0 ||
    isRunningCompare ||
    !canRun ||
    !arePromptTurnsValid;

  const runDisabledTooltip = useMemo(() => {
    if (!runPrimaryDisabled) {
      return null;
    }
    if (isDraft) {
      return "Save this test case before you can run it.";
    }
    if (casePinnedOnly) {
      return "Render checks run with the full suite, not on their own.";
    }
    if (selectedModelValues.length === 0) {
      return "Select at least one model to run.";
    }
    if (!canRun) {
      return "Configure suite servers before running.";
    }
    if (!arePromptTurnsValid && editForm) {
      return (
        getStepsBlockReason(editForm.steps) ??
        "Fix the test configuration before running."
      );
    }
    if (isRunningCompare) {
      return null;
    }
    if (missingServers.length > 0) {
      if (ensureServersReady != null) {
        return "Click Run to connect required MCP servers and start.";
      }
      return "Connect MCP servers in the playground, then run.";
    }
    // Defensive: every other disabled reason should be covered above; keep a
    // string so the Run affordance is never disabled without an explanation.
    return "Run is unavailable for this test right now.";
  }, [
    runPrimaryDisabled,
    casePinnedOnly,
    selectedModelValues.length,
    canRun,
    missingServers,
    isRunningCompare,
    arePromptTurnsValid,
    editForm,
    ensureServersReady,
    isDraft,
  ]);

  // Bulk replace of all steps — the flat StepListEditor edits the `TestStep[]`
  // directly and writes the whole sequence back.
  const setSteps = useCallback((next: TestStep[]) => {
    setEditForm((current) => (current ? { ...current, steps: next } : current));
  }, []);

  // Latest `steps` mirrored into a ref so the recorder's append (a stable
  // callback) can read the current step list without putting `editForm` in its
  // deps — that would churn `previewRecorder`'s identity on every keystroke and
  // reload the live widget.
  const editFormStepsRef = useRef<TestStep[]>(editForm?.steps ?? []);
  useEffect(() => {
    editFormStepsRef.current = editForm?.steps ?? [];
  }, [editForm?.steps]);

  // Append a recorder-captured widget step (interact or assert) to the END of
  // turn `turnIndex`'s block in the flat step list. The recorder reports a
  // turn-granular `promptIndex`; `stepTurnIndices` maps each step to its
  // implicit turn, so we splice in right after that turn's last step (or append
  // to the end if that turn has no steps yet).
  const appendWidgetStepToTurn = useCallback(
    (turnIndex: number, step: TestStep) => {
      const currentSteps = editFormStepsRef.current;
      const turnOf = stepTurnIndices(currentSteps);
      let insertAt = currentSteps.length;
      for (let i = currentSteps.length - 1; i >= 0; i--) {
        if (turnOf[i] === turnIndex) {
          insertAt = i + 1;
          break;
        }
      }
      const next = [...currentSteps];
      next.splice(insertAt, 0, step);
      setEditForm((current) =>
        current ? { ...current, steps: next } : current,
      );
    },
    [],
  );

  // NOTE: the live record panel deliberately does NOT reflect its whole
  // conversation back into the spec. The right pane is a sandbox; auto-adopting
  // the model's actual tool calls as `expectedToolCalls` would silently author
  // assertions the user never asked for. The only sanctioned right→left writes
  // are the explicit widget recorder (`previewRecorder`) and the assert chooser.

  // Confirm an assert-mode pick: append the chosen widget assertion as an
  // `assert` TestStep at the end of the picked turn's block, then close the
  // chooser. Functional setState reads the pending pick so this stays a stable
  // callback.
  const handleAssertPickConfirm = useCallback(
    (assertion: StepAssertion) => {
      setPendingPick((pick) => {
        if (!pick) return null;
        appendWidgetStepToTurn(pick.promptIndex, {
          id: newWidgetStepId("wassert"),
          kind: "assert",
          assertion: stepAssertionToWidgetAssertion(pick.toolName, assertion),
        });
        return null;
      });
    },
    [appendWidgetStepToTurn],
  );
  // The live record surface emits a step for ANY clicked widget. Save it as an
  // `interact` (or open the assert chooser) into the turn `resolvePromptIndex`
  // reported for the clicked widget — but only into turns that already exist in
  // the authored spec. A click on a widget from a typed-but-not-yet-added turn
  // is dropped (the user adds that prompt to the test first — Phase 2b).
  const handleRecorderStep = useCallback(
    (event: RecorderStepEvent) => {
      const turnIndex = event.promptIndex;
      const authoredTurns = groupStepsIntoTurns(
        editFormStepsRef.current,
      ).length;
      const saved = shouldSaveLiveRecorderStep(event) && turnIndex < authoredTurns;
      recorderDebug("editor recorder step received", {
        eventToolName: event.toolName,
        eventPromptIndex: event.promptIndex,
        eventToolCallId: event.toolCallId,
        saved,
      });
      if (!saved) return;
      const step = event.step as ScriptedStep;
      // Assert mode: a click selects an element to check rather than an action to
      // replay. Capture its derived locator and open the chooser; ignore
      // non-click steps (e.g. `type`/`change`) — those aren't a pick gesture.
      if (captureModeRef.current === "assert") {
        if (step.kind === "click") {
          setPendingPick({
            promptIndex: turnIndex,
            toolName: event.toolName,
            locator: step.target,
          });
        }
        return;
      }
      appendWidgetStepToTurn(turnIndex, {
        id: newWidgetStepId("interact"),
        kind: "interact",
        toolName: event.toolName,
        action: step as unknown as InteractAction,
      });
    },
    [appendWidgetStepToTurn],
  );
  const handleRecorderReady = useCallback((event?: RecorderReadyEvent) => {
    recorderDebug("editor recorder ready received", {
      event: event as unknown as Record<string, unknown>,
    });
  }, []);
  // RECORD-CAPABLE bundle for the live Record panel. Every widget loads the shim
  // on its first render (`recordCapable`), so a click on any live widget emits a
  // step; `handleRecorderStep` files it into the widget's turn. No armed target —
  // live mode records every widget in the session.
  const previewRecorder = useMemo<RecorderProps | undefined>(() => {
    return {
      recordCapable: true,
      onRecorderStep: handleRecorderStep,
      onRecorderReady: handleRecorderReady,
    };
  }, [handleRecorderStep, handleRecorderReady]);

  // Pre-run Preview: render the forming spec through the SAME chat surface as a
  // real run (synthesized trace: prompt + expected tool calls), so the editor's
  // Preview is one consistent renderer instead of a bespoke spec component.
  // (Hook MUST stay above the `if (!currentTestCase)` early return.)
  const specPreviewTrace = useMemo(
    () => buildSpecPreviewTrace(editForm?.steps ?? []),
    [editForm?.steps],
  );


  const buildSavePayload = (form: TestTemplate) => {
    const isNegativeTest = deriveIsNegativeTestFromSteps(form.steps);
    // `query`/`expectedToolCalls`/`expectedOutput` are denormalized display
    // projections of `steps` (the runner reads `steps`, never these). A
    // negative test expects no model tool calls, so its flattened display list
    // is empty.
    const steps = form.steps;
    const query = deriveQuery(steps);
    const expectedToolCalls = isNegativeTest
      ? []
      : deriveExpectedToolCalls(steps);

    // Normalize the predicate envelope before it crosses the wire. The
    // in-memory editForm keeps a draft `list` in `inherit` mode so the
    // user can flip back to `replace`/`extend` without losing their work,
    // but the persisted envelope must carry an empty list there — the
    // runner ignores it AND `casePredicatesSchema` still validates each
    // row with `predicateSchema` regardless of mode, so a stale invalid
    // row would be rejected downstream even though the case is "safe".
    const normalizedPredicates = form.predicates
      ? form.predicates.mode === "inherit"
        ? { ...form.predicates, list: [] }
        : form.predicates
      : form.predicates;

    return {
      title: form.title,
      runs: form.runs,
      scenario: form.scenario?.trim() ? form.scenario.trim() : undefined,
      query,
      expectedToolCalls,
      // No per-step `expectedOutput` in the steps model (the legacy per-turn
      // field is gone); it stays undefined just as it already did for any
      // steps-authored case.
      expectedOutput: undefined as string | undefined,
      steps,
      isNegativeTest,
      advancedConfig: normalizeAdvancedConfig(form.advancedConfig),
      matchOptions: form.matchOptions,
      predicates: normalizedPredicates,
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
      steps: savePayload.steps,
      // Legacy export consumers may still read promptTurns.
      promptTurns: stepsToPromptTurns(savePayload.steps),
      isNegativeTest: savePayload.isNegativeTest,
      advancedConfig: savePayload.advancedConfig,
      scenario: savePayload.scenario,
    });
  };

  // First Save of a prompt draft: insert into Convex (instead of updating a
  // record that does not exist yet), then hand the new id to the parent so it
  // can swap the `draft:<kind>` route for the real one.
  const handleCreateFromDraft = async () => {
    if (!editForm || isSavingDraft) return;

    if (!validateSteps(editForm.steps)) {
      toast.error(
        getStepsBlockReason(editForm.steps) ??
          "Fix the test configuration before saving.",
      );
      return;
    }

    setIsSavingDraft(true);
    try {
      const savePayload = buildSavePayload(editForm);
      const newTestCaseId = await createTestCaseMutation({
        suiteId,
        models: currentTestCase?.models ?? [],
        ...savePayload,
      });
      posthog.capture("eval_test_case_created", {
        location: "test_template_editor",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: suiteId ?? null,
        test_case_id: newTestCaseId,
        num_models: currentTestCase?.models?.length ?? 0,
        num_steps: editForm.steps?.length ?? 0,
      });
      toast.success("Test case created");
      onDraftSaved?.(newTestCaseId);
    } catch (error) {
      console.error("Failed to create test case:", error);
      toast.error(getBillingErrorMessage(error, "Failed to create test case"));
      throw error;
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleSave = async () => {
    if (isDraft) {
      await handleCreateFromDraft();
      return;
    }
    if (!editForm || !currentTestCase) return;

    if (!validateSteps(editForm.steps)) {
      toast.error(
        getStepsBlockReason(editForm.steps) ??
          "Fix the test configuration before saving.",
      );
      return;
    }

    try {
      const savePayload = buildSavePayload(editForm);
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        ...savePayload,
        // Pass `null` (not undefined) so the mutation knows to clear a
        // previously-persisted case-level override when the user resets it.
        matchOptions: savePayload.matchOptions ?? null,
        // Same null-clears-the-field convention for the predicate override.
        predicates: savePayload.predicates ?? null,
      });
      posthog.capture("eval_test_case_edited", {
        location: "test_template_editor",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: suiteId ?? null,
        test_case_id: currentTestCase._id,
        num_models: currentTestCase.models?.length ?? 0,
        num_steps: editForm.steps?.length ?? 0,
        has_match_options: savePayload.matchOptions != null,
        has_predicates: savePayload.predicates != null,
      });
      toast.success("Changes saved");
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save changes"));
      throw error;
    }
  };

  const buildSelectedCompareModels = (
    modelValues: string[],
  ): Array<{ provider: string; model: string }> => {
    return modelValues.map((modelValue) => {
      const { provider, model } = parseModelValue(modelValue);
      if (!provider || !model) {
        throw new Error(`Invalid model selection: ${modelValue}`);
      }
      return { provider, model };
    });
  };

  const persistCompareRunDraft = async (
    savePayload: ReturnType<typeof buildSavePayload>,
    modelValues: string[],
  ) => {
    if (!currentTestCase) {
      return;
    }

    const nextModels = buildSelectedCompareModels(modelValues);

    const currentModels: Array<{ provider: string; model: string }> =
      currentTestCase.models ?? [];
    const modelsUnchanged =
      currentModels.length === nextModels.length &&
      currentModels.every(
        (model, index) =>
          model.provider === nextModels[index]?.provider &&
          model.model === nextModels[index]?.model,
      );

    if (!hasUnsavedChanges && modelsUnchanged) {
      return;
    }

    await updateTestCaseMutation({
      testCaseId: currentTestCase._id,
      ...(hasUnsavedChanges
        ? {
            ...savePayload,
            // null (not undefined) signals "clear" — required to wipe a
            // previously-persisted case-level matchOptions override.
            matchOptions: savePayload.matchOptions ?? null,
            predicates: savePayload.predicates ?? null,
          }
        : {}),
      ...(modelsUnchanged ? {} : { models: nextModels }),
    });
  };

  const latestHistoricalCompareRunId = useMemo(
    () => resolveLatestCompareRunId(recentIterations),
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
    setMobileVisibleModelValue((current) =>
      current && selectedModelValues.includes(current)
        ? current
        : selectedModelValues[0] ?? null,
    );
  }, [selectedModelValues]);

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

  // Multi-model compare still uses the dedicated side-by-side grid view; the
  // single-model flow streams into the right-pane Preview instead (see run
  // start). Kept for the compare path + route deep-links.
  const openRunView = useCallback(
    (source: "run_compare" | "config_toggle") => {
      setEditorMode("run");
      onSelectTab?.("runs");
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
    [currentTestCase?._id, onSelectTab, selectedModelValues, suiteId],
  );

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
    // A draft has no Convex id to attach iterations to — Run is disabled in the
    // UI until the user saves; this guards the programmatic paths too.
    if (isDraft) {
      return;
    }
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

    if (!validateSteps(editForm.steps)) {
      toast.error(
        getStepsBlockReason(editForm.steps) ??
          "Fix the test configuration before running.",
      );
      return;
    }

    const suiteServers = normalizeSuiteServerRefs(quickRunSuiteServers);
    if (suiteServers.length === 0) {
      toast.error("No MCP servers are configured for this suite.");
      return;
    }
    const disconnectedSuiteServers = suiteServers.filter(
      (name) => !connectedServerNames.has(name),
    );
    if (disconnectedSuiteServers.length > 0) {
      if (ensureServersReady != null) {
        const readiness = await ensureServersReady(suiteServers);
        if (hasUnavailableServers(readiness)) {
          toast.error(
            formatEnsureServersReadyError(
              readiness,
              "run this test case",
              projectServers,
            ),
          );
          return;
        }
      } else {
        toast.error(
          formatMcpConnectServerPrompt(disconnectedSuiteServers, {
            remoteServers: projectServers,
            kind: "test-case",
          }),
        );
        return;
      }
    }

    const savePayload = buildSavePayload(editForm);
    const comparePreviewTrace = buildComparePreviewTrace(savePayload.steps);
    compareRunUserStoppedRef.current = false;
    const reusableCompareRunId =
      options?.sessionMode === "reuse"
        ? activeCompareRunId ?? latestHistoricalCompareRunId
        : null;
    const compareRunId = reusableCompareRunId ?? createCompareSessionId();
    const startsNewCompareSession = reusableCompareRunId == null;

    if (startsNewCompareSession) {
      try {
        await persistCompareRunDraft(savePayload, selectedModelValues);
      } catch (error) {
        console.error("Failed to save test case before compare run:", error);
        toast.error(
          getBillingErrorMessage(
            error,
            "Failed to save test case before running",
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
          projectId: isDirectGuest ? null : projectId,
          suite: {
            ...suite,
            environment: {
              ...(suite.environment ?? {}),
              servers: suiteServers,
            },
          },
          testCase: currentTestCase,
          selectedModel: modelValue,
          getAccessToken,
          namedHostId: quickRunHostPlan.namedHostId,
          testCaseOverrides: {
            query: savePayload.query,
            expectedToolCalls: savePayload.expectedToolCalls,
            isNegativeTest: savePayload.isNegativeTest,
            runs: iterationOverride,
            expectedOutput: savePayload.expectedOutput,
            steps: savePayload.steps,
            advancedConfig,
            matchOptions: savePayload.matchOptions,
            predicates: savePayload.predicates,
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
    const previewExpectedToolCalls = deriveExpectedToolCalls(savePayload.steps);
    // Step-aligned cases (a widget interact, or a DOM widget assertion) open on
    // the Steps replay — the 1:1 mirror of the authored steps. Pure prompt+grade
    // cases keep Chat: a transcript predicate like `toolCalledWith` (derived
    // from expectedToolCalls) is a grade, NOT a recorded widget step.
    const defaultRunColumnTab: RunColumnTab = normalizeSteps(
      savePayload.steps,
    ).some(
      (s) =>
        s.kind === "interact" ||
        (s.kind === "assert" && isWidgetAssertion(s.assertion)),
    )
      ? "steps"
      : "chat";
    setRunColumnTabByModel((previous) => ({
      ...previous,
      ...Object.fromEntries(
        runModelValues.map((modelValue) => [modelValue, defaultRunColumnTab]),
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
    setReplayIteration(null);
    if (selectedModelValues.length > 1) {
      // Multi-model compare keeps the dedicated side-by-side grid view.
      openRunView("run_compare");
    } else {
      // Single-model: stream the run into the right-pane Preview instead of
      // switching views. Pin this run's model and surface the live conversation.
      setLastRunModelValue(selectedModelValues[0] ?? null);
      setShowSpecOverride(false);
      setPreviewTab("preview");
    }

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
                  // Defensive safety net for the server's read-after-write race
                  // (the server now polls the finalized row before emitting, but
                  // if the iteration is STILL missing while an `iterationId` IS
                  // present, the run genuinely completed — only the row read
                  // raced). buildCompareRunRecord maps a null iteration to
                  // status "idle" / result null, which the tally below treats as
                  // a loss → false "Compare run failed for all selected models".
                  // Mark it completed instead, keeping the streamed preview.
                  const finalRecord: CompareRunRecord =
                    event.iteration == null && event.iterationId != null
                      ? { ...record, status: "completed" }
                      : record;
                  setCompareRunRecords((previous) => ({
                    ...previous,
                    [modelValue]: {
                      ...finalRecord,
                      streamingTrace: previous[modelValue]?.streamingTrace,
                      streamingDraftMessages:
                        previous[modelValue]?.streamingDraftMessages,
                      streamingActualToolCalls:
                        previous[modelValue]?.streamingActualToolCalls,
                      streamingMetrics: previous[modelValue]?.streamingMetrics,
                      streamingStepStatus:
                        previous[modelValue]?.streamingStepStatus,
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
                      streamingStepStatus: existing?.streamingStepStatus,
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
                      stepStatus: existing.streamingStepStatus ?? {},
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
                      streamingStepStatus: streamState.stepStatus,
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
                if (compareRequestGenByModelRef.current[modelValue] !== myGen) {
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
                  streamingStepStatus: existing?.streamingStepStatus,
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

      // A run counts as successful when it produced an iteration OR completed
      // cleanly without one (the read-after-write guard above). Genuine
      // failures carry status "failed"/"cancelled" and never match, so they
      // still drive the partial / "failed for all" toasts.
      const successfulCount = completedRecords.filter(
        (record) => record.iteration != null || record.status === "completed",
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
  // Quick Run executes the GRADED run for every model count: it persists an
  // iteration (Runs tab), grades fully (judge/checks + the headless harness
  // replaying recorded widget interactions), and — for a single model — surfaces
  // that run's trace in the Preview. The live Playground preview stays for
  // authoring + recording; it no longer drives Quick Run.
  const handlePrimaryRun = useCallback(() => {
    void handleRunCompare();
  }, [handleRunCompare]);

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

  const connectedServerList = quickRunSuiteServers.filter((name: string) =>
    connectedServerNames.has(name),
  );
  const runGridClassName =
    selectedCompareRecords.length <= 1
      ? "lg:grid-cols-1"
      : selectedCompareRecords.length === 2
      ? "lg:grid-cols-2"
      : "lg:grid-cols-3";

  // Single-model Preview: the record we stream live / show the result for.
  const previewRecord =
    selectedCompareRecords.find(
      (r) => r.modelValue === selectedModelValues[0],
    ) ?? selectedCompareRecords[0];
  // Single surface: Quick Run executes the GRADED path (`handleRunCompare` →
  // `RunColumn` → streaming trace with Results / Trace / Chat / Browser / Raw
  // tabs). The Chat tab renders the live, record-capable widget (author widget
  // interactions HERE — `interactiveChat`/`recorder` are wired below), and the
  // Browser tab shows the headless harness replaying the recorded clicks. For a
  // single model the run streams into THIS Preview pane; "View spec"
  // (`showSpecOverride`) flips to the spec view before/between runs.
  const showRunInPreview =
    !!previewRecord &&
    !showSpecOverride &&
    (isRunningCompare ||
      (previewRecord.modelValue === lastRunModelValue &&
        previewRecord.status !== "idle"));

  // Live Record mode inputs: a CONFIG-ONLY handoff (case model / system /
  // temperature) plus the case's first prompt, auto-run so a live widget mounts
  // immediately. No messages are seeded — replaying prior widgets live is out of
  // scope (seeding `user` text alone wouldn't re-render them).
  const liveChatSteps = editForm?.steps ?? currentSteps;
  const liveChatFirstPrompt =
    liveChatSteps.find(isPromptStep)?.prompt.trim() || undefined;
  const liveChatHandoff = currentTestCase
    ? buildCaseChatHandoff({
        caseId: String(currentTestCase._id),
        serverNames: effectiveSuiteServers,
        modelId: previewRecord?.model ?? selectedModelValues[0],
        advancedConfig: currentAdvancedConfig,
      })
    : null;

  const latestAvailableIteration =
    routeCompareAnchorIteration ??
    recentIterations[0] ??
    lastSavedIteration ??
    null;
  // For the Preview's default-on-open, only land on a run that actually has a
  // trace (`blob`/`chatSessionId`). A traceless run (e.g. one that failed before
  // producing a transcript) would render IterationDetails as a bare tool-call
  // diff, which is confusing as a default — fall through to the spec instead.
  const latestTracedIteration =
    [routeCompareAnchorIteration, ...recentIterations, lastSavedIteration].find(
      (it): it is EvalIteration => !!it && !!(it.blob || it.chatSessionId),
    ) ?? null;
  // Advisory judge verdict for whichever iteration the drill-in renders,
  // joined from the iteration's run (in `suiteRuns`) by caseKey. Surfaced on
  // the Results tab of IterationDetails so per-case reasoning has a deep home.
  const replayJudgeCase = resolveIterationJudge(replayIteration, suiteRuns);
  const latestTracedJudgeCase = resolveIterationJudge(
    latestTracedIteration,
    suiteRuns,
  );
  const latestAvailableResult = latestAvailableIteration
    ? computeIterationResult(latestAvailableIteration)
    : null;
  /** Visual + a11y cue on View results / Open last run (replaces header status chip). */
  const latestRunNavCue =
    latestAvailableResult === "failed"
      ? {
          dotClass: "size-1.5 shrink-0 rounded-full bg-destructive/50",
          buttonTextClass: "text-destructive",
          ariaResults: "View results, last run failed",
          ariaOpen: "Open last run, failed",
        }
      : latestAvailableResult === "passed"
      ? {
          dotClass: "size-1.5 shrink-0 rounded-full bg-success/50",
          buttonTextClass: "text-success",
          ariaResults: "View results, last run passed",
          ariaOpen: "Open last run passed",
        }
      : latestAvailableResult === "cancelled"
      ? {
          dotClass: "size-1.5 shrink-0 rounded-full bg-warning/50",
          buttonTextClass: "text-warning",
          ariaResults: "View results, last run stopped",
          ariaOpen: "Open last run stopped",
        }
      : {
          dotClass:
            "size-1.5 shrink-0 rounded-full bg-warning/50 animate-pulse motion-reduce:animate-none",
          buttonTextClass: "text-warning",
          ariaResults: "View results, run in progress",
          ariaOpen: "Open last run, in progress",
        };
  // Render checks are no longer a separate editor — a case whose turns are all
  // pinned renders here like any other, just with the model-only UI hidden
  // (see `casePinnedOnly` below).
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Assert-mode pick chooser: opens when a click is captured in "Add
          checks" mode, builds a widget assertion seeded with the derived
          locator. Portaled, so its position here doesn't affect layout. */}
      <AssertPickChooser
        pick={pendingPick}
        onConfirm={handleAssertPickConfirm}
        onCancel={() => setPendingPick(null)}
      />
      {editorMode === "config" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <div className="min-w-0 flex-1 basis-[min(100%,12rem)]">
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
                    className="min-w-0 w-full bg-transparent px-0 py-0 text-lg font-semibold tracking-tight focus:outline-none sm:text-xl"
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 w-full text-left"
                    onClick={handleTitleClick}
                  >
                    <h2 className="truncate text-lg font-semibold tracking-tight transition-opacity hover:opacity-80 sm:text-xl">
                      {editForm?.title || currentTestCase.title}
                    </h2>
                  </button>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
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
                {editForm ? (
                  <CasePassCriteriaPopover
                    matchOptions={editForm.matchOptions}
                    onMatchOptionsChange={(next) =>
                      setEditForm((current) =>
                        current ? { ...current, matchOptions: next } : current,
                      )
                    }
                    suiteDefaultMatchOptions={suite?.defaultMatchOptions}
                    predicates={editForm.predicates}
                    onPredicatesChange={(next: CasePredicates | undefined) =>
                      setEditForm((current) =>
                        current ? { ...current, predicates: next } : current,
                      )
                    }
                    suiteDefaultPredicates={
                      (suite?.defaultPredicates ?? []) as Predicate[]
                    }
                    availableTools={availableTools.map((t) => t.name)}
                    onAppendScenarioToSteps={(scenarioAsserts) => {
                      setEditForm((current) => {
                        if (!current) return current;
                        return {
                          ...current,
                          steps: appendScenarioPredicatesAsAssertSteps(
                            current.steps,
                            scenarioAsserts,
                          ),
                        };
                      });
                    }}
                  />
                ) : null}
                {quickRunHostOptions.length > 0 ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label className="inline-flex cursor-pointer items-center">
                          <span className="sr-only">Host</span>
                          <span className="inline-flex h-8 max-w-[7.5rem] items-center gap-1 rounded-md border border-input/80 bg-background px-1.5">
                            {selectedQuickRunHostLogoSrc ? (
                              <img
                                src={selectedQuickRunHostLogoSrc}
                                alt=""
                                className="size-3.5 shrink-0 object-contain"
                              />
                            ) : null}
                            <select
                              className="min-w-0 max-w-[5.5rem] truncate bg-transparent text-xs text-foreground outline-none"
                              value={quickRunHostSelection ?? ""}
                              onChange={(event) =>
                                setQuickRunHostSelection(event.target.value)
                              }
                              aria-label="Host for the next run"
                              disabled={isRunningCompare}
                            >
                              {quickRunHostOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </span>
                        </label>
                      </TooltipTrigger>
                      <TooltipContent variant="muted" side="top" sideOffset={6}>
                        Host for the next run
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    // Attachment-less suite: the run uses the suite's own host
                    // config (defaulting to MCPJam). Show it read-only so the
                    // host is always visible — never an empty/hostless state.
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex h-8 max-w-[7.5rem] items-center gap-1 rounded-md border border-input/80 bg-background px-1.5 text-xs text-foreground"
                          aria-label="Host for the next run"
                        >
                          {suiteHostLogoSrc ? (
                            <img
                              src={suiteHostLogoSrc}
                              alt=""
                              className="size-3.5 shrink-0 object-contain"
                            />
                          ) : null}
                          <span className="truncate">{suiteHostLabel}</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent variant="muted" side="top" sideOffset={6}>
                        Host for the next run
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="inline-flex cursor-pointer items-center">
                        <span className="sr-only">Iterations</span>
                        <select
                          className="h-8 w-10 rounded-md border border-input/80 bg-background px-1 text-center text-xs text-foreground"
                          value={iterationOverride}
                          onChange={(e) =>
                            setIterationOverride(Number(e.target.value))
                          }
                          aria-label="Iterations for the next run"
                          disabled={isRunningCompare}
                        >
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(
                            (n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    </TooltipTrigger>
                    <TooltipContent variant="muted" side="top" sideOffset={6}>
                      Iterations for the next run
                    </TooltipContent>
                  </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={liveRecordMode ? "secondary" : "outline"}
                      size="sm"
                      className="h-8"
                      aria-pressed={liveRecordMode}
                      onClick={() => {
                        // Turning ON: leave the spec override so the live panel
                        // shows. The preview gate keeps past-run review
                        // (`replayIteration`) winning over Record mode.
                        if (!liveRecordMode) setShowSpecOverride(false);
                        setLiveRecordMode((v) => !v);
                      }}
                    >
                      <Circle
                        className={
                          "size-3.5" +
                          (liveRecordMode ? " fill-red-500 text-red-500" : "")
                        }
                      />
                      {liveRecordMode ? "Recording" : "Record"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent variant="muted" side="top" sideOffset={6}>
                    {liveRecordMode
                      ? "Live record mode — click widgets to interact (no grading)"
                      : "Record: open a live playground to click widgets"}
                  </TooltipContent>
                </Tooltip>
                {runDisabledTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          onClick={() => handlePrimaryRun()}
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
                                : "Quick Run"}
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
                      onClick={() => handlePrimaryRun()}
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
                            : "Quick Run"}
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
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="flex w-1/2 min-h-0 flex-col gap-5 overflow-y-auto overscroll-y-contain border-r border-border px-4 py-5 sm:px-6">
              {replayIteration && !showSpecOverride ? (
                <ReplayedScenarioPane
                  iteration={replayIteration}
                  edited={replaySnapshotEdited}
                  onBackToEditing={() => setReplayIteration(null)}
                />
              ) : (
                <>
                  {runPrimaryDisabled &&
                  !isRunningCompare &&
                  runDisabledTooltip ? (
                    <p
                      className="text-xs leading-snug text-muted-foreground sm:text-right"
                      data-testid="test-template-run-blocked-hint"
                    >
                      {runDisabledTooltip}
                    </p>
                  ) : null}

                  <div className="space-y-4 pt-1">
                    {editForm ? (
                      <StepListEditor
                        steps={editForm.steps}
                        onStepsChange={setSteps}
                        availableTools={availableTools}
                        // Thread the effective argumentMatching mode (suite
                        // default merged with case override) so the per-leaf
                        // placeholder picker offers the right options and
                        // disables itself in `ignore` mode.
                        argumentMatching={
                          resolveMatchOptions(
                            suite?.defaultMatchOptions,
                            editForm.matchOptions,
                          ).argumentMatching
                        }
                        suiteServers={effectiveSuiteServers}
                        projectServers={projectServers}
                        evalValidationBorderClass={evalValidationBorderClass}
                        stepStatusByTurn={liveStepStatusByTurn}
                        stepStatusById={liveStepStatusById}
                        syncedStepId={syncedStepId}
                        onHoverStep={setSyncedStepId}
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
                </>
              )}
            </div>
            <CasePreviewPane
              tab={previewTab}
              onTabChange={setPreviewTab}
              runsCount={recentIterations.length}
              runsDotClass={
                latestAvailableIteration ? latestRunNavCue.dotClass : undefined
              }
              previewSlot={
                replayIteration && !showSpecOverride ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <IterationDetails
                      iteration={replayIteration}
                      testCase={currentTestCase}
                      serverNames={effectiveSuiteServers}
                      layoutMode="full"
                      judgeCase={replayJudgeCase}
                    />
                  </div>
                ) : liveRecordMode && !showSpecOverride ? (
                  // Record mode: a LIVE, auto-connected playground bound to this
                  // case. Click live widgets; no grading (runner is out of this
                  // path). Stable key = case id so the session/cart survives
                  // re-renders within a case.
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Click widgets to record ·
                      </span>
                      <CaptureModeToggle
                        mode={captureMode}
                        onChange={setCaptureMode}
                      />
                      <span className="truncate text-[11px] text-muted-foreground">
                        {captureMode === "assert"
                          ? "Click an element to add a check about it."
                          : "Click inside a view to record actions."}
                      </span>
                    </div>
                    <div className="min-h-0 flex-1">
                      <EvalLiveChatPanel
                        key={`eval-live:${currentTestCase?._id ?? "none"}`}
                        projectId={projectId}
                        caseServerNames={effectiveSuiteServers}
                        initialPrompt={liveChatFirstPrompt}
                        autoRun={!!liveChatFirstPrompt}
                        ensureServersReady={ensureServersReady}
                        evalChatHandoff={liveChatHandoff}
                        recorder={previewRecorder}
                      />
                    </div>
                  </div>
                ) : showRunInPreview && previewRecord ? (
                  <div className="flex h-full min-h-0 flex-col">
                    {!isRunningCompare ? (
                      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-[12px] text-muted-foreground">
                        <span className="truncate">
                          Last run · {previewRecord.modelLabel}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-2 text-[11px]"
                          onClick={() => setShowSpecOverride(true)}
                        >
                          View spec
                        </Button>
                      </div>
                    ) : null}
                    <div className="min-h-0 flex-1">
                      <RunColumn
                        record={previewRecord}
                        testCase={currentTestCase}
                        authoredSteps={editForm?.steps ?? currentSteps}
                        serverNames={connectedServerList}
                        projectId={projectId}
                        onContinueInChat={onContinueInChat}
                        onStreamingTraceLoaded={() =>
                          clearCompareStreamingState(previewRecord.modelValue)
                        }
                        activeTab={
                          runColumnTabByModel[previewRecord.modelValue] ??
                          "chat"
                        }
                        onTabChange={(tab) =>
                          handleRunColumnTabChange(
                            previewRecord.modelValue,
                            tab,
                          )
                        }
                        onRetry={() =>
                          void handleRunCompare({
                            modelValues: [previewRecord.modelValue],
                            sessionMode: "reuse",
                          })
                        }
                        baselineHostStyle={hostConfigBaseline?.hostStyle}
                        syncedStepId={syncedStepId}
                        onSyncStep={setSyncedStepId}
                      />
                    </div>
                  </div>
                ) : latestTracedIteration ? (
                  // No in-memory run loaded (e.g. fresh open / reload) but the
                  // case has a past run WITH a trace: default the Preview to that
                  // run's trace, not the spec — that's the surface users expect
                  // here. (A brand-new case, or one whose only runs are traceless,
                  // falls through to the spec.)
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      <IterationDetails
                        iteration={latestTracedIteration}
                        testCase={currentTestCase}
                        serverNames={effectiveSuiteServers}
                        layoutMode="full"
                        judgeCase={latestTracedJudgeCase}
                      />
                    </div>
                  </div>
                ) : specPreviewTrace ? (
                  // Pre-run preview: the forming spec rendered through the same
                  // chat surface as a real run (user bubble + expected tool-call
                  // chips). Read-only — editing lives in the left step list, and
                  // the widget appears once a Quick Run produces output.
                  <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
                    <TraceViewer
                      trace={specPreviewTrace}
                      forcedViewMode="chat"
                      hideToolbar
                      fillContent
                      chromeDensity="compact"
                    />
                  </div>
                ) : (
                  <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
                    Start typing a prompt — the conversation will build here.
                  </div>
                )
              }
              runsSlot={
                <div className="h-full overflow-y-auto">
                  <CaseRunsHistory
                    iterations={recentIterations}
                    selectedIterationId={replayIteration?._id ?? null}
                    suiteRuns={suiteRuns}
                    hostNamesById={hostNamesById}
                    defaultHostLabel={suiteHostLabel}
                    hasHostAttachments={hasHostAttachments}
                    onSelectIteration={(it) => {
                      setReplayIteration(it);
                      setShowSpecOverride(false);
                      setPreviewTab("preview");
                    }}
                  />
                </div>
              }
            />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-b px-4 py-3 sm:px-6">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
                          onClick={() => handlePrimaryRun()}
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

            <div className="mt-3">
              <CaseEditorTabs
                active="runs"
                onSelect={(tab) => {
                  if (tab === "edit") {
                    setEditorMode("config");
                    onSelectTab?.("edit");
                  }
                }}
                runsDotClass={
                  latestAvailableIteration
                    ? latestRunNavCue.dotClass
                    : undefined
                }
                runsAriaLabel={
                  latestAvailableIteration
                    ? latestRunNavCue.ariaResults
                    : "Runs"
                }
              />
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
            {isCompareRouteLoading ? (
              compareRouteLoadingState
            ) : selectedCompareRecords.length === 0 ? (
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center">
                <div>
                  <div className="text-sm font-medium">No runs yet</div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Switch back to Edit and click Run to create your first
                    iteration.
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
                        testCase={currentTestCase}
                        authoredSteps={editForm?.steps ?? currentSteps}
                        serverNames={connectedServerList}
                        projectId={projectId}
                        onContinueInChat={onContinueInChat}
                        onStreamingTraceLoaded={() =>
                          clearCompareStreamingState(record.modelValue)
                        }
                        activeTab={
                          runColumnTabByModel[record.modelValue] ?? "chat"
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
                        baselineHostStyle={hostConfigBaseline?.hostStyle}
                        syncedStepId={syncedStepId}
                        onSyncStep={setSyncedStepId}
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
  testCase,
  serverNames,
  projectId,
  onContinueInChat,
  onStreamingTraceLoaded,
  activeTab,
  onTabChange,
  onRetry,
  baselineHostStyle,
  syncedStepId,
  onSyncStep,
  interactiveChat = false,
  recorder,
  authoredSteps,
  onRenderedWidgetTargets,
}: {
  record: CompareRunRecord;
  testCase: any;
  /**
   * The live authored steps (the same list the editor's left pane renders).
   * Quick Run executes the in-memory draft without persisting it to `testCase`,
   * so deriving steps from `testCase` alone hides the Steps tab on unsaved
   * drafts — pass the draft explicitly and prefer it.
   */
  authoredSteps?: TestStep[];
  serverNames: string[];
  projectId: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  onStreamingTraceLoaded: () => void;
  activeTab: RunColumnTab;
  onTabChange: (tab: RunColumnTab) => void;
  onRetry: () => void;
  /** Left↔right Steps sync (shared with the editor's step list). */
  syncedStepId?: string | null;
  onSyncStep?: (stepId: string | null) => void;
  // Tier 3 live preview: make the chat trace interactive + recorder-armed.
  // Default off so the side-by-side compare grid stays read-only.
  interactiveChat?: boolean;
  recorder?: RecorderProps;
  /** Reports widgets THIS run rendered (per turn) up to the editor, which merges
   *  them with the spec-authored record targets. Replaces wholesale (incl. empty)
   *  and clears on unmount. Wired only on the previewRecord instance. */
  onRenderedWidgetTargets?: (targets: RenderedWidgetTarget[]) => void;
  /**
   * The suite's baseline hostStyle (from `hostConfigsV2:getSuiteConfig`),
   * used as the fallback when the iteration's snapshot doesn't carry an
   * override. May be undefined when the suite hostConfig hasn't loaded.
   */
  baselineHostStyle: string | undefined;
}) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const globalPreferenceHostStyle = usePreferencesStore(
    (state) => state.hostStyle,
  );
  /**
   * Effective hostStyle for this iteration's result chrome:
   *   1. iteration snapshot's per-Run override (authoritative — what
   *      the run actually ran with);
   *   2. suite baseline (the suite's saved default);
   *   3. global preference (last resort — old leaky behavior, kept
   *      so multi-pane views still have a value while data loads).
   *
   * Index into the snapshot is loose (`any`) because the schema treats
   * `hostConfigOverride` as `v.any()` — the Convex validator doesn't
   * pin the shape of the per-Run override.
   */
  const snapshotHostStyle = (
    record.iteration?.testCaseSnapshot as
      | { hostConfigOverride?: { hostStyle?: string } }
      | undefined
  )?.hostConfigOverride?.hostStyle;
  const hostStyle =
    snapshotHostStyle ?? baselineHostStyle ?? globalPreferenceHostStyle;
  const { toolsMetadata, toolServerMap, connectedServerIds } =
    useEvalTraceToolContext({
      serverNames,
      projectId,
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
    ? resolveDisplayExpectedToolCalls(record.iteration.testCaseSnapshot, null)
    : record.previewExpectedToolCalls != null
    ? record.previewExpectedToolCalls
    : resolveDisplayExpectedToolCalls(null, testCase);
  const actualToolCalls =
    record.iteration?.actualToolCalls ?? record.streamingActualToolCalls ?? [];
  const showToolsTab =
    expectedToolCalls.length > 0 || actualToolCalls.length > 0;

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

  // Browser/Replay tab: shown only when the persisted blob carries headless
  // artifacts (render observations / interaction steps / replay video). Mirrors
  // TraceViewer's own `hasBrowserArtifacts` gate so the quick-run panel surfaces
  // the SAME Browser view (incl. the `<video>` replay) the Runs detail does.
  const browserBlob = persistedTraceBlob as TraceEnvelope | null;
  const showBrowserTab =
    (Array.isArray(browserBlob?.widgetRenderObservations) &&
      browserBlob!.widgetRenderObservations!.length > 0) ||
    (Array.isArray(browserBlob?.browserInteractionSteps) &&
      browserBlob!.browserInteractionSteps!.length > 0) ||
    (typeof browserBlob?.videoUrl === "string" &&
      browserBlob.videoUrl.length > 0);

  // Report the widgets THIS run rendered (per turn) up to the editor, which
  // merges them with the spec-authored record targets. Persisted observations
  // are authoritative; the streaming envelope's spans are the optimistic
  // stand-in until they resolve (EvalTraceBlobV1 carries spans but no
  // observations, so the helper's span fallback fires during streaming).
  const renderedTargets = useMemo(
    () => deriveRenderedWidgetTargets(browserBlob ?? streamingTraceEnvelope),
    [browserBlob, streamingTraceEnvelope],
  );
  const onRenderedWidgetTargetsRef = useRef(onRenderedWidgetTargets);
  useEffect(() => {
    onRenderedWidgetTargetsRef.current = onRenderedWidgetTargets;
  }, [onRenderedWidgetTargets]);
  const lastEmittedTargetsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onRenderedWidgetTargetsRef.current) return;
    const key = JSON.stringify(renderedTargets);
    if (key === lastEmittedTargetsRef.current) return;
    lastEmittedTargetsRef.current = key;
    onRenderedWidgetTargetsRef.current(renderedTargets);
  }, [renderedTargets]);
  // Clear on unmount so a hidden/switched preview leaves no stale chips behind.
  useEffect(() => {
    return () => onRenderedWidgetTargetsRef.current?.([]);
  }, []);

  // Step-aligned replay: the Steps tab mirrors the authored step list, with this
  // run's artifacts bucketed under their authoredStepId (W1). Shown whenever the
  // case carries authored steps.
  // Prefer the live authored draft (what the editor's left pane shows and what
  // Quick Run actually executes); fall back to the run's own snapshot, then the
  // committed case. Deriving from `testCase` alone hid the Steps tab after a
  // Quick Run on an unsaved draft (steps live in `authoredSteps`, not yet in
  // `testCase`).
  const caseSteps = useMemo(() => {
    if (authoredSteps && authoredSteps.length > 0) return authoredSteps;
    const snapshotSteps = loadSteps(record.iteration?.testCaseSnapshot);
    if (snapshotSteps.length > 0) return snapshotSteps;
    return loadSteps(testCase);
  }, [authoredSteps, record.iteration?.testCaseSnapshot, testCase]);
  const showStepsTab = caseSteps.length > 0;
  const runStepStatusById = useMemo<Map<string, EvalStepStatus> | undefined>(() => {
    const status = record.streamingStepStatus;
    if (!status) return undefined;
    const map = new Map<string, EvalStepStatus>();
    for (const entry of Object.values(status)) {
      if (entry.stepId) map.set(entry.stepId, entry.status);
    }
    return map.size > 0 ? map : undefined;
  }, [record.streamingStepStatus]);

  const effectiveActiveTab: RunColumnTab =
    activeTab === "tools" && !showToolsTab
      ? "timeline"
      : activeTab === "browser" && !showBrowserTab
      ? "timeline"
      : activeTab === "steps" && !showStepsTab
      ? "chat"
      : activeTab;
  const traceMode =
    effectiveActiveTab === "chat"
      ? "chat"
      : effectiveActiveTab === "timeline"
      ? "timeline"
      : effectiveActiveTab === "raw"
      ? "raw"
      : effectiveActiveTab === "browser"
      ? "browser"
      : effectiveActiveTab === "steps"
      ? "steps"
      : "tools";
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

    return {
      messages: adaptedTrace.messages,
      serverNames,
      executionConfig: {
        modelId: record.model,
        systemPrompt:
          typeof advancedConfig?.system === "string"
            ? advancedConfig.system
            : undefined,
        temperature:
          typeof advancedConfig?.temperature === "number"
            ? advancedConfig.temperature
            : undefined,
        requireToolApproval:
          typeof advancedConfig?.requireToolApproval === "boolean"
            ? advancedConfig.requireToolApproval
            : undefined,
      },
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
  // Wire a widget `ui/message` follow-up to the live playground: hand off this
  // run's conversation plus the widget's message so the playground continues it
  // and the model replies live — exactly as chat would. No-op until a trace
  // exists (null payload) or when no handoff handler is wired.
  const handleWidgetFollowUp = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !onContinueInChat || !continueInChatPayload) return;
      onContinueInChat({
        ...continueInChatPayload,
        pendingUserMessage: trimmed,
      });
    },
    [onContinueInChat, continueInChatPayload],
  );
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
    if (r.status === "cancelled" || r.result === "cancelled")
      return "cancelled";
    if (r.status === "failed" || r.result === "failed") return "error";
    if (r.iteration != null || r.status === "completed") return "ready";
    return "idle";
  };

  const runColumnResult: "passed" | "failed" | null =
    record.result === "passed"
      ? "passed"
      : record.result === "failed" || record.status === "failed"
      ? "failed"
      : null;
  // Live (streaming) chat trace used as the Chat surface's fallback before the
  // persisted blob is available.
  const chatFallbackTrace =
    streamingTraceEnvelope ?? activeLiveChatTrace ?? null;
  const renderedRunContent =
    // Render the Chat tab through ONE CompareRunChatSurface across streaming →
    // completed (it owns the fallbackTrace → persisted-blob swap internally).
    // Previously streaming used <TraceViewer> and completion swapped to
    // <CompareRunChatSurface>, a different component tree — that tore down the
    // live widget subtree on completion and re-fetched it, wiping in-flight
    // widget state (e.g. a populated cart). One instance preserves it.
    traceMode === "chat" &&
    (record.iteration != null || chatFallbackTrace != null) ? (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CompareRunChatSurface
          iteration={record.iteration ?? null}
          traceModel={{
            id: record.model,
            name: record.modelLabel,
            provider: record.provider as any,
          }}
          isLoading={isRunningRecord}
          emptyMessage={`No ${activeTab} data is available for this run.`}
          fallbackTrace={chatFallbackTrace}
          onTraceLoaded={onStreamingTraceLoaded}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          traceBlob={persistedTraceBlob}
          traceBlobLoading={persistedTraceLoading}
          traceBlobError={persistedTraceError}
          preserveLiveFallbackTrace={streamingTraceEnvelope != null}
          // Keep streaming read-only (matches the prior TraceViewer behavior).
          // The recorder bundle still needs to be present from first widget mount:
          // adding its iframe shim only after completion changes the sandbox
          // resource payload and reloads the live widget document.
          interactive={record.iteration ? interactiveChat : false}
          recorder={recorder}
          sendFollowUpMessage={handleWidgetFollowUp}
        />
      </div>
    ) : record.iteration ? (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EvalTraceSurface
          iteration={record.iteration}
          testCase={testCase}
          mode={traceMode}
          steps={caseSteps}
          stepStatusById={runStepStatusById}
          syncedStepId={syncedStepId}
          onSyncStep={onSyncStep}
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
      </div>
    ) : hasStreamingTrace ? (
      isWaitingForFirstTimelineSnapshot ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border/50 bg-muted/10 px-6 py-10 text-center">
          <div className="max-w-sm">
            <div className="text-sm font-medium">
              Timeline appears after the first step completes
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Chat and raw output are already streaming for the current
              in-flight step.
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
            steps={caseSteps}
            stepStatusById={runStepStatusById}
            syncedStepId={syncedStepId}
            onSyncStep={onSyncStep}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
            connectedServerIds={connectedServerIds}
            hideToolbar
            fillContent
          />
        </div>
      )
    ) : record.status === "running" && !record.iteration ? (
      // Chat-while-running is handled by the unified CompareRunChatSurface above
      // (via `chatFallbackTrace`); only the Tools live-preview remains here.
      traceMode === "tools" && activeLiveChatTrace ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TraceViewer
            trace={activeLiveChatTrace}
            model={{
              id: record.model,
              name: record.modelLabel,
              provider: record.provider as any,
            }}
            forcedViewMode="tools"
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
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-warning/50 bg-warning/50 px-6 py-10">
        <div className="max-w-sm text-center">
          <div className="text-sm font-medium text-foreground">
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

  const runColumnSummary: MultiModelCardSummary = {
    modelId: record.modelValue,
    durationMs: record.metrics.durationMs,
    tokens: displayTokens,
    toolCount,
    interactionCount: Array.isArray(browserBlob?.browserInteractionSteps)
      ? browserBlob!.browserInteractionSteps!.length
      : 0,
    status: toSummaryStatus(record),
    hasMessages:
      record.iteration != null ||
      record.streamingTrace != null ||
      (record.streamingDraftMessages?.length ?? 0) > 0,
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-compare-model-label={record.modelLabel}
    >
      <PreviewHeaderSlot>
        <ModelCompareCardHeader
          summary={runColumnSummary}
          allSummaries={[runColumnSummary]}
          mode={
            effectiveActiveTab === "browser" ||
            effectiveActiveTab === "steps"
              ? "timeline"
              : effectiveActiveTab
          }
          onModeChange={onTabChange}
          showTraceTabs
          showComparisonChrome={false}
          compactCompareHeader={false}
          result={runColumnResult}
          showToolsTab={showToolsTab}
          showStepsTab={showStepsTab}
          stepsActive={effectiveActiveTab === "steps"}
          onSelectSteps={() => onTabChange("steps")}
          showBrowserTab={showBrowserTab}
          browserActive={effectiveActiveTab === "browser"}
          onSelectBrowser={() => onTabChange("browser")}
          tabsInline
          actionsSlot={
            <>
              {/* Continue in Chat is temporarily hidden while guest playground testing is in progress. */}
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
        />
      </PreviewHeaderSlot>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-3 pt-1.5">
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
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
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
