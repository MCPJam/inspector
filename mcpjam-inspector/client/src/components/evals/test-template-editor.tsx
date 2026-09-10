import { useServerActionsOptional } from "@/state/server-actions-context";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "@/lib/mcpjam-agent/eval-tool-metadata";
import { DEFAULTS } from "./constants";
import {
  caseViewModel,
  capturedCaseChanged,
} from "../evaluate/case-workspace/case-view-model";
import { promoteEvalDraftChat } from "@/lib/mcpjam-agent/eval-scope";
import { useEvalAgentDraft } from "@/lib/mcpjam-agent/use-eval-agent-draft";
import { getEvalDraft } from "@/lib/mcpjam-agent/eval-workspace";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { track } from "@/lib/analytics";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { mintCaseId } from "@mcpjam/sdk/contract";
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
import { listEvalTools, streamEvalTestCase } from "@/lib/apis/evals-api";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { StepListEditor } from "./step-list-editor";
import {
  EvalAttachmentsEditor,
  type EvalAttachment,
} from "./eval-attachments-editor";
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
import {
  MAX_SCRIPTED_STEP_TEXT_CHARS,
  MAX_SCRIPTED_WAIT_MS,
  trimmedField,
  type ElementLocator,
  type ScriptedStep,
  type StepAssertion,
} from "@/shared/scripted-steps";
import { AssertPickChooser, type AssertPick } from "./assert-pick-chooser";
import { CaseRunsHistory } from "./runs/case-runs-history";
import { ReplayedScenarioPane } from "./runs/replayed-scenario-pane";
import { IterationDetails } from "./iteration-details";
import { TrialChainPanel } from "@/components/evaluate/trial-chain-panel";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import {
  JudgeVerdictPanel,
  resolveIterationJudge,
} from "./goal-completion-presentation";
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
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import type { EditEvalCaseDraftInspectorCommand } from "@/shared/inspector-command.js";
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
  isInteractStep,
  isModelFree,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  normalizeSteps,
  promptTurnsToSteps,
  resolveDisplayExpectedToolCalls,
  stepAssertionToWidgetAssertion,
  stepsToPromptTurns,
  insertStepAfter,
  lastStepIdOfTurn,
  newStepId,
  stepTurnIndices,
  WIDGET_ASSERTION_LABELS,
  type InteractAction,
  type InteractStep,
  type TestStep,
  type ToolCallStep,
  type WidgetAssertion,
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
  resolveCasePredicates,
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
import { ImportClaimDetails } from "./import-claim-badge";
import { QuickCaseRunCostEstimateHint } from "./run-cost-estimate-hint";
import { useHost } from "@/hooks/useClients";
import { useHarnessBuiltinToolCatalog } from "@/hooks/useHarnessBuiltinTools";
import { mergeSystemToolsIntoAvailableTools } from "./harness-system-tools";
import { parseDraftTestCaseId } from "./draft-test-case";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { computeIterationResult } from "./pass-criteria";
import {
  ScenarioHostStyleProvider,
  ScenarioHostThemeProvider,
} from "@/contexts/scenario-client-style-context";
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
  EvalJudgeConfigOverride,
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
import { hasReplayArtifacts } from "./browser-step-replay";
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
  getScenarioHostLabel,
  getScenarioHostLogo,
  getScenarioShellStyle,
  normalizeScenarioHostStyleId,
} from "@/lib/scenario-client-style";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { SimpleCaseForm } from "../evaluate/simple-case/simple-case-form";
import { CaseSpine } from "../evaluate/case-spine/case-spine";
import { CaseJudgeAnswer } from "../evaluate/case-scorecard/case-judge-answer";
import {
  appendCaseScorer,
  buildCaseScorecard,
  type CaseScorecardInput,
} from "../evaluate/case-scorecard/case-scorecard-model";
import { coverageDetailByStage } from "../evaluate/case-scorecard/case-coverage";
import { NextQuestionLine } from "../evaluate/case-scorecard/next-question-line";
import { groupCaseIterations } from "./runs/group-case-iterations";
import {
  SuggestedFromRunSection,
  useSuggestedScorers,
} from "../evaluate/case-scorecard/suggested-from-run-section";
import type { Suggestion } from "../evaluate/case-scorecard/suggest-from-run";
import { CaseRunSetup } from "../evaluate/case-workspace/case-run-setup";
import {
  caseHasOwnAssertion,
  deriveCaseKind,
  initialToolsChoice,
  isToolCalledWithAssert,
  readSimpleCase,
  readStepChecks,
  writeSimpleCase,
  type SimpleCaseTool,
  resolveToolsQuestion,
  UNSET_TOOLS_BLOCK_REASON,
  type ToolsChoice,
} from "../evaluate/simple-case/simple-case-model";
import { WorkspaceStepsPane } from "../evaluate/simple-case/workspace-steps-pane";
import { DefaultChecksReference } from "../evaluate/case-workspace/default-checks-reference";
import { CaseChecksPage } from "../evaluate/case-workspace/case-checks-page";
import { withCaseJudgeSkipped } from "../evaluate/case-scorecard/case-scorecard-model";
import { CaseRunTimeline } from "../evaluate/case-workspace/case-run-timeline";
import { CaseWorkspaceLayout } from "../evaluate/case-workspace/case-workspace-layout";
import { DescribeCaseWorkspace } from "../evaluate/case-workspace/describe-case-workspace";
import { InspectStrip } from "../evaluate/case-workspace/inspect-strip";
import { TrialHeader } from "../evaluate/case-workspace/trial-header";
import {
  createAttemptId,
  leftViewFor,
  paneViewFor,
  selectedTrialIteration,
  trialVerdict,
  type SelectedTrial,
} from "../evaluate/case-workspace/selected-trial";

import { parseStepStatusById } from "@/shared/eval-step-replay";
import { chainForQuickRunIteration } from "../evaluate/simple-case/quick-run-chain";
import { TrialJudgeReviewPanel } from "./trial-judge-review";
import { TrialScorecard } from "../evaluate/case-scorecard/trial-scorecard";
import { authoredForTrial } from "../evaluate/case-scorecard/trial-authored";
import { adoptRouteFromIteration } from "../evaluate/simple-case/route-rollup";

interface TestTemplate {
  title: string;
  runs: number;
  scenario?: string;
  steps: TestStep[];
  advancedConfig?: Record<string, unknown>;
  matchOptions?: EvalMatchOptions;
  /** Case-level predicate gate override; undefined ⇒ inherit suite defaults. */
  predicates?: CasePredicates;
  /** Authored rubric for the model judge. Empty string clears it. */
  expectedOutput?: string;
  /**
   * The one per-case judge override the backend admits: opt out. No per-case
   * model, threshold or role exists to write.
   */
  judgeConfigOverride?: EvalJudgeConfigOverride;
  kind?: "capability" | "regression";
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
  connectedServerNames: Set<string>;
  projectId: string | null;
  /**
   * Read each opened trial's user-value chain, and show it above its trace.
   *
   * The editor is the one host of `IterationDetails` that can: it resolves the
   * replayed iteration's RUN from `suiteRuns` and holds the project id, which
   * is exactly what the chain read needs and what the other four hosts lack.
   * Off by default, and off issues no request.
   */
  trialChainEnabled?: boolean;
  /**
   * Evaluate (New) only: author a single-turn case as the three-question
   * simple form (`components/evaluate/simple-case/`) instead of the flat step
   * list, and offer the per-trial chain and route rollup on quick runs.
   *
   * OFF by default, and the default is what keeps `/evals` byte-identical.
   * This editor is shared — the shipped Evals tab, the Evaluate tab, CI Runs
   * and the desktop surfaces all mount it — so the SURFACE decides, exactly
   * as `suiteDetailOverview` and `evaluateDecisionSummary` do. Only
   * `EvaluateTab` passes it, via `SuiteIterationsView`.
   */
  simpleCaseEditor?: boolean;
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
  /**
   * Renders the case as a SPINE — numbered actions with their checks nested
   * under the action each one follows — instead of the form plus the Steps
   * hatch plus the header gear. Arrives as a prop, resolved once on the
   * Evaluate surface, so `/evals` cannot reach it and a test toggles it
   * without a flag mock.
   */
  observeFirst?: boolean;
  /**
   * Launch a run of THIS case only, as a suite run.
   *
   * "Run test" needs a suite run because the judge is keyed by `suiteRunId`
   * end to end; a quick run cannot be graded. Absent on a surface that cannot
   * launch one, and Run test then does not render.
   */
  onRunCase?: (
    caseId: string,
    opts?: { iterationOverride?: number; skipJudge?: boolean },
  ) => void | Promise<void>;
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
    options?: { allowInteractiveOAuthFlow?: boolean },
  ) => Promise<EnsureServersReadyResult>;
  projectServers?: RemoteServer[];
  /**
   * Called after an unsaved draft case is persisted for the first time, with the
   * new Convex id, so the parent can swap the `draft:<kind>` route for the real
   * one. Only relevant when `selectedTestCaseId` is a draft sentinel.
   */
  onDraftSaved?: (newTestCaseId: string) => void;
  /** Open suite overview / settings from the simple-case read-only chips. */
  onOpenSuiteSettings?: () => void;
  checksPage?: boolean;
  onOpenCaseChecks?: () => void;
  onCloseCaseChecks?: () => void;
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
    runs: DEFAULTS.RUNS_PER_TEST,
    models,
    caseType: "prompt",
  };
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

/**
 * The authoring gap in a widget step (`interact`, or an `assert` carrying a
 * `WidgetAssertion`), or null when it is complete — phrased for the blocked
 * Save/Run tooltip.
 *
 * These mirror the backend `assertValidSteps` rules (mcpjam-backend
 * `convex/lib/steps.ts`). The editor seeds every widget step with placeholder
 * fields it cannot fill for the user — `toolName: ""`, `target: { testId: "" }`
 * — so without this gate an untouched step reaches `createTestCase` and the
 * mutation rejects the whole save with a raw `ConvexError` (Sentry CONVEX-1PD,
 * CONVEX-1P2). Keep in lockstep with `assertValidInteractStep` /
 * `assertValidWidgetAssertion`.
 */
function getWidgetStepGap(step: TestStep): string | null {
  if (isInteractStep(step)) return getInteractStepGap(step);
  if (
    isAssertStep(step) &&
    typeof step.assertion === "object" &&
    step.assertion !== null &&
    isWidgetAssertion(step.assertion)
  ) {
    return getWidgetAssertionGap(step.assertion);
  }
  return null;
}

const tooLong = (value: unknown): boolean =>
  typeof value === "string" && value.length > MAX_SCRIPTED_STEP_TEXT_CHARS;

/**
 * Mirrors the discriminants of `interactActionSchema` (`@mcpjam/sdk/contract`).
 */
const INTERACT_ACTION_KINDS: readonly InteractAction["kind"][] = [
  "click",
  "type",
  "key",
  "scroll",
  "wait",
];

function getInteractStepGap(step: InteractStep): string | null {
  // Stored blobs reach the editor cast, never parsed, so `action` can arrive
  // missing or carrying a kind this editor has no fields for. Settle that
  // before the label reads `action.kind`.
  const a = step.action as InteractAction | undefined;
  if (!a || typeof a !== "object" || !INTERACT_ACTION_KINDS.includes(a.kind)) {
    return "Pick an action for the interact step.";
  }
  const label = `${a.kind} step`;
  if (!trimmedField(step.toolName)) {
    return `Pick a view (tool) for the ${label}.`;
  }
  switch (a.kind) {
    case "click":
      return getLocatorGap(a.target, label);
    case "type":
      return (
        getLocatorGap(a.target, label) ??
        (tooLong(a.text)
          ? `Shorten the typed text to ${MAX_SCRIPTED_STEP_TEXT_CHARS} characters or fewer.`
          : null)
      );
    case "key":
      return trimmedField(a.key) ? null : "Enter a key for the key step.";
    case "scroll":
      return a.amount === undefined ||
        (Number.isInteger(a.amount) && a.amount >= 1)
        ? null
        : "Scroll amount must be a whole number of 1 or more.";
    case "wait":
      return Number.isInteger(a.ms) && a.ms >= 1 && a.ms <= MAX_SCRIPTED_WAIT_MS
        ? null
        : `Wait must be a whole number of milliseconds between 1 and ${MAX_SCRIPTED_WAIT_MS}.`;
  }
}

function getWidgetAssertionGap(a: WidgetAssertion): string | null {
  // `isWidgetAssertion` only asserts that `kind` is a string, so an unknown one
  // has no label — and would otherwise fall past the switch as "complete".
  const name = WIDGET_ASSERTION_LABELS[a.kind];
  if (!name) return "Pick a check type for the widget check.";
  const label = name.toLowerCase();
  if (!trimmedField(a.toolName)) {
    return `Pick a view (tool) for the ${label} check.`;
  }
  switch (a.kind) {
    case "textVisible":
      if (!trimmedField(a.text)) return "Enter the text the check looks for.";
      return tooLong(a.text)
        ? `Shorten the expected text to ${MAX_SCRIPTED_STEP_TEXT_CHARS} characters or fewer.`
        : null;
    case "elementVisible":
    case "elementHidden":
      return getLocatorGap(a.target, `${label} check`);
    case "inputValue":
      return (
        getLocatorGap(a.target, `${label} check`) ??
        (tooLong(a.equals)
          ? `Shorten the expected value to ${MAX_SCRIPTED_STEP_TEXT_CHARS} characters or fewer.`
          : null)
      );
    case "widgetToolCalled":
      return trimmedField(a.calledToolName)
        ? null
        : "Enter the tool name the view is expected to call.";
  }
}

/**
 * A locator needs at least one reference point, and every field it does carry
 * must be non-empty. Both halves matter: `{}` fails the backend's
 * "at least one of" check, while `{ testId: "" }` (the editor's placeholder) and
 * `{ role: { role: "" } }` clear that check and fail its per-field non-empty
 * ones — a truthy `role` object satisfies the bundle but an empty ARIA role
 * string does not.
 */
function getLocatorGap(
  loc: ElementLocator | undefined,
  label: string,
): string | null {
  const gap = `Pick an element target for the ${label}.`;
  if (!loc || typeof loc !== "object") return gap;
  for (const value of [loc.text, loc.css, loc.testId]) {
    if (value !== undefined && !trimmedField(value)) return gap;
  }
  if (loc.role !== undefined) {
    if (typeof loc.role !== "object" || loc.role === null) return gap;
    if (!trimmedField(loc.role.role)) return gap;
  }
  // Past those checks a present field is a usable one, so "carries at least
  // one" is just "at least one is set".
  const hasReferencePoint = [loc.role, loc.text, loc.css, loc.testId].some(
    (value) => value !== undefined,
  );
  return hasReferencePoint ? null : gap;
}

const validateSteps = (steps: TestStep[]): boolean => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return false;
  }

  // Each step must be complete: prompts need text, tool calls need a server +
  // real tool, widget steps need a view and a resolvable element target.
  for (const step of steps) {
    if (isPromptStep(step)) {
      if (!step.prompt.trim()) return false;
    } else if (isToolCallStep(step)) {
      if (isToolCallStepIncomplete(step)) return false;
    } else if (getWidgetStepGap(step)) {
      return false;
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

  // Widget steps report the FIRST gap rather than a joined list: each carries a
  // different message, so one specific instruction beats a merged one. Turn
  // numbers come from the runner's grouping (`stepTurnIndices`) — the same one
  // the step cards number themselves by, so the message points at the card the
  // user is looking at.
  const turnIndices = stepTurnIndices(steps);
  for (const [i, step] of steps.entries()) {
    const gap = getWidgetStepGap(step);
    if (!gap) continue;
    return turns.length === 1 ? gap : `${gap} (turn ${turnIndices[i] + 1})`;
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
  trialChainEnabled = false,
  simpleCaseEditor = false,
  observeFirst = false,
  onRunCase,
  isDirectGuest = false,
  ensureServersReady,
  projectServers,
  onDraftSaved,
  onOpenSuiteSettings,
  checksPage = false,
  onOpenCaseChecks,
  onCloseCaseChecks,
}: TestTemplateEditorProps) {
  // Resolves the WorkOS token for signed-in users and the guest bearer for
  // guests (project-owning guests included). See use-convex-access-token.
  const getAccessToken = useConvexAccessToken();
  const simpleCaseEditorEnabled = simpleCaseEditor;
  const [deepEditor, setDeepEditor] = useState(false);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  /**
   * The tool question's stored answer for the workspace form.
   *
   * The EDITOR owns it, not the form: it decides `isNegativeTest` on save and
   * on quick run, so a value the form reported back through an effect would
   * trail by one render — long enough for a save to send the wrong flag. It is
   * seeded from the persisted case in the case-switch effect, in the same
   * commit as `editForm`.
   */
  const [simpleToolsChoice, setSimpleToolsChoice] =
    useState<ToolsChoice>("unset");
  /** Lifted with the choice, so "Use tools instead" survives the Steps pane. */
  const [simpleStashedTools, setSimpleStashedTools] = useState<
    SimpleCaseTool[]
  >([]);
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
  const liveStepStatusById = useMemo<
    Map<string, EvalStepStatus> | undefined
  >(() => {
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
  const [trialTabRequest, setTrialTabRequest] = useState<{
    iterationId: string;
    mode: "steps";
  } | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [mobileVisibleModelValue, setMobileVisibleModelValue] = useState<
    string | null
  >(null);
  const [isRunningCompare, setIsRunningCompare] = useState(false);
  /**
   * Transient per-run iteration count (1-10). Applies to the next Run
   * triggered from this editor; does NOT mutate the persisted
   * `EvalCase.runs` default. Mirrors the suite-header picker.
   */
  const [iterationOverride, setIterationOverride] = useState<number>(
    DEFAULTS.RUNS_PER_TEST,
  );
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
  const [inspectIterationId, setInspectIterationId] = useState<string | null>(
    null,
  );
  const [simpleValidationAttempted, setSimpleValidationAttempted] =
    useState(false);
  const [missingAppEvidenceStepId, setMissingAppEvidenceStepId] = useState<
    string | null
  >(null);
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

  // Same readiness gate the suite list upstream uses: a signed-in actor must
  // wait for its `users` row, while an actor that will never have one (a
  // direct guest) keeps reading. Covers every suite-scoped read below —
  // the editor stays mounted across an identity change, so any ungated one
  // re-fires on its own schedule in exactly the window the gate exists for.
  const canQuerySuite = useActorCanQuery();

  const testCases = useQuery(
    "testSuites:listTestCases" as any,
    canQuerySuite ? ({ suiteId } as any) : "skip",
  ) as any[] | undefined;

  const currentTestCase = useMemo(() => {
    if (draftKind) {
      return buildDraftTestCase(selectedTestCaseId, testCases);
    }
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [draftKind, testCases, selectedTestCaseId]);

  const routeCompareAnchorIteration = useQuery(
    "testSuites:getTestIteration" as any,
    canQuerySuite && routeCompareAnchorIterationId
      ? { iterationId: routeCompareAnchorIterationId }
      : "skip",
  ) as EvalIteration | null | undefined;

  const lastSavedIteration = useQuery(
    "testSuites:getTestIteration" as any,
    canQuerySuite && currentTestCase?.lastMessageRun
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

  const suite = useQuery(
    "testSuites:getTestSuite" as any,
    canQuerySuite ? ({ suiteId } as any) : "skip",
  ) as any;

  /**
   * Suite-level hostConfig (v2). The same query SuiteExecutionConfigEditor
   * uses — single source of truth for model / system / temperature /
   * hostContext / capabilities / style at the suite level.
   */
  const suiteHostConfigDto = useQuery(
    "hostConfigsV2:getSuiteConfig" as any,
    canQuerySuite ? ({ suiteId } as any) : "skip",
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
    setInspectIterationId(null);
    setSimpleValidationAttempted(false);
    setMissingAppEvidenceStepId(null);
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
    setInspectIterationId(routeCompareAnchorIteration._id);
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
      runs: currentTestCase.runs ?? DEFAULTS.RUNS_PER_TEST,
      scenario: currentTestCase.scenario ?? "",
      steps,
      advancedConfig: normalizeAdvancedConfig(currentTestCase.advancedConfig),
      matchOptions: currentTestCase.matchOptions,
      predicates: currentTestCase.predicates,
      expectedOutput: currentTestCase.expectedOutput ?? "",
      judgeConfigOverride: currentTestCase.judgeConfigOverride,
      kind: currentTestCase.kind,
    });
    // Seed the transient picker from the persisted runs so a user who saved
    // runs=N still sees N selected when the editor opens. Clamp to [1, 10]
    // — the picker only exposes that range.
    setIterationOverride(
      Math.max(1, Math.min(10, currentTestCase.runs ?? DEFAULTS.RUNS_PER_TEST)),
    );
    // Seed the tool question from what the case ALREADY says, in the same
    // commit as `editForm`: the persisted `isNegativeTest` (never re-derived
    // from step shape) plus its tool asserts. Without this, opening a positive
    // CLI case would default to "unset" and its first save would rewrite the
    // flag the author never touched.
    const seededTools = readSimpleCase(steps).tools;
    setSimpleToolsChoice(
      initialToolsChoice({
        tools: seededTools,
        isNegativeTest: currentTestCase.isNegativeTest,
      }),
    );
    setSimpleStashedTools(seededTools);
    setDeepEditor(false);
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

  /**
   * The RUN whose trial the drill-in is showing, and that trial's chain.
   *
   * ABOVE THE EARLY RETURN, and that placement is load-bearing rather than
   * stylistic: this component returns a loading state before `currentTestCase`
   * resolves, so a hook called below it runs on some renders and not others —
   * which React reports as "rendered more hooks than during the previous
   * render". A test caught exactly that.
   *
   * The run is resolved here for the same reason `replayHostId` is: an
   * iteration knows its `suiteRunId` and nothing else about the run, and the
   * chain read needs the run's status and revision to know whether there is
   * anything to read and when to re-read it. The candidate order mirrors
   * `latestTracedIteration` below — the replayed trial first, then whichever
   * traced iteration the drill-in would fall back to.
   */
  const openTrialRun = useMemo(() => {
    const runId =
      replayIteration?.suiteRunId ??
      [
        routeCompareAnchorIteration,
        ...recentIterations,
        lastSavedIteration,
      ].find(
        (it): it is EvalIteration => !!it && !!(it.blob || it.chatSessionId),
      )?.suiteRunId;
    if (!runId) return null;
    return suiteRuns.find((run) => run._id === runId) ?? null;
  }, [
    replayIteration,
    routeCompareAnchorIteration,
    recentIterations,
    lastSavedIteration,
    suiteRuns,
  ]);

  const chainSlotEnabled = trialChainEnabled || simpleCaseEditorEnabled;
  const trialChains = useEvalRunIterationChains({
    projectId,
    run: openTrialRun,
    enabled: chainSlotEnabled,
  });

  /**
   * The chain panel for one opened trial, or nothing.
   *
   * Run-backed trials come from the run-id keyed hook. Quick runs have no
   * run id, so the same projection + assembler runs locally on the doc
   * the client already holds.
   */
  const nextQuestionForTrial = (iteration: EvalIteration | null) => {
    return useSpine && iteration ? (
      <NextQuestionLine
        state={{
          hasTrial: true,
          judgedPass: Boolean(
            iteration.suiteRunId &&
            resolveIterationJudge(iteration, suiteRuns)?.passed,
          ),
          hasFailure: iteration.result === "failed",
          trials: suggestionBatch?.iterations.length ?? 1,
          hasChecks:
            Boolean(editForm?.predicates?.list?.length) ||
            (editForm?.steps ?? []).some((step) => step.kind === "assert"),
          hasSuggestions: chainSuggestions.output.suggestions.length > 0,
          suiteHasGate: Boolean(
            suite?.defaultPredicates?.some(
              (p: Predicate) => p.role !== "advisory",
            ),
          ),
        }}
        onAct={(action) => {
          if (action === "trials" || action === "models") {
            // The next-run sheet left with the workspace redesign: the run
            // controls sit in the header now, so the action primes the count
            // there and leaves the model choice to that same control.
            if (action === "trials") {
              setEditForm((current) =>
                current ? { ...current, runs: 3 } : current,
              );
              setIterationOverride((current) => Math.max(current, 3));
            }
          } else if (action === "gate") onOpenSuiteSettings?.();
          else if (action === "failure") {
            setTrialTabRequest({ iterationId: iteration._id, mode: "steps" });
          } else if (action === "harden") {
            suggestionsRef.current?.scrollIntoView?.({
              block: "nearest",
              behavior: "smooth",
            });
          }
        }}
      />
    ) : null;
  };

  const trialChainSlotFor = (iteration: EvalIteration | null) => {
    let chain: ReactNode = null;
    // On the spine the chain lives INSIDE the Scorecard as a chip strip: the
    // trial header already carries the verdict on every tab, and the stage
    // detail only makes sense beside the rows it explains. Above the tabs it
    // showed half the story on Chat and Raw.
    if (iteration && chainSlotEnabled && !useSpine) {
      if (iteration.suiteRunId) {
        const assembled = trialChains.chains.get(iteration._id);
        chain = assembled ? (
          <TrialChainPanel
            chain={assembled}
            resetKey={iteration._id}
            detailByStage={useSpine ? chainDetailByStage : undefined}
          />
        ) : null;
      } else {
        // The record handed in may be the SSE `complete` snapshot. A judge
        // landing after that rewrites the chain's last link, and the Convex
        // subscription carries the newer doc — so prefer it when present.
        const live =
          recentIterations.find((it) => it._id === iteration._id) ?? iteration;
        chain = (
          <TrialChainPanel
            chain={chainForQuickRunIteration(live)}
            resetKey={iteration._id}
            detailByStage={useSpine ? chainDetailByStage : undefined}
          />
        );
      }
    }

    return chain;
  };

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
      ? resolveHostLogoByName(selectedQuickRunHostOption.label)
      : null;
  // Effective host for an attachment-less suite — its own configured host
  // style, defaulting to MCPJam. Mirrors the server's `loadSuiteHostConfig`
  // default so the chip names the host the run actually uses.
  const suiteHostStyle =
    normalizeScenarioHostStyleId(hostConfigBaseline?.hostStyle) ??
    DEFAULT_HOST_STYLE_V2;
  const suiteHostLabel = getScenarioHostLabel(suiteHostStyle);
  const suiteHostLogoSrc = getScenarioHostLogo(suiteHostStyle);

  const hostNamesById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite?.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite?.hostAttachments]);
  const hasHostAttachments = (suite?.hostAttachments?.length ?? 0) > 0;

  // ── Harness system tools (assertable built-ins) ──────────────────────────
  // Mirror the server's `loadSuiteHostConfig` precedence: with host
  // attachments the run executes under the SELECTED attached host's config;
  // only an attachment-less suite runs under the suite hostConfig. Gate the
  // system-tool merge on whichever of those actually carries a harness, so
  // emulated suites never see bash/read/… in the assertion dropdowns.
  const { isAuthenticated } = useConvexAuth();
  const { host: selectedQuickRunHost } = useHost({
    isAuthenticated,
    hostId: hasHostAttachments ? (selectedQuickRunHostId ?? null) : null,
  });
  const suiteRunHarnessId = hasHostAttachments
    ? (selectedQuickRunHost?.config?.harness ?? null)
    : (hostConfigBaseline?.harness ?? null);
  const { tools: harnessBuiltinCatalog } =
    useHarnessBuiltinToolCatalog(suiteRunHarnessId);
  // MCP-server tools plus the harness's native built-ins — what the expected
  // tool calls / check pickers offer. Pickers needing an MCPJam-invokable tool
  // (pinned tool calls, widget selects) filter `source === "system"` back out.
  const assertableTools = useMemo(
    () =>
      mergeSystemToolsIntoAvailableTools(availableTools, harnessBuiltinCatalog),
    [availableTools, harnessBuiltinCatalog],
  );

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

  const serverActions = useServerActionsOptional();
  const metadataServerIdsKey = JSON.stringify(
    [...effectiveSuiteServers].sort(),
  );
  const metadataEnvironmentKey = JSON.stringify([
    suiteId,
    suite?.environment,
    metadataServerIdsKey,
  ]);
  const metadataTarget = useMemo(
    () => ({
      projectId: projectId ?? "",
      environmentKey: metadataEnvironmentKey,
      serverIds: JSON.parse(metadataServerIdsKey) as string[],
    }),
    [projectId, metadataEnvironmentKey, metadataServerIdsKey],
  );
  const metadataEntries = useEvalToolMetadata((s) => s.entries);
  const toolsMetadataState = useMemo(
    () => readEvalToolMetadata(metadataTarget),
    [metadataTarget, metadataEntries],
  );
  const loadServerMetadata = useCallback(
    (serverId: string) => listEvalTools({ projectId, serverIds: [serverId] }),
    [projectId],
  );
  const retryToolsMetadata = useCallback(
    async (serverId?: string) => {
      const ids = serverId ? [serverId] : metadataTarget.serverIds;
      const failed = readEvalToolMetadata(metadataTarget).servers.filter(
        (server) =>
          ids.includes(server.serverId) && server.action === "reconnect",
      );
      for (const server of failed) {
        const name =
          projectServers?.find((candidate) => candidate._id === server.serverId)
            ?.name ?? server.serverId;
        if (serverActions) {
          try {
            await serverActions.reconnectServer(name);
          } catch {
            /* The interactive path below can renew authorization. */
          }
        }
        if (ensureServersReady) {
          const result = await ensureServersReady([name], {
            allowInteractiveOAuthFlow: true,
          });
          if (!result.readyServerNames.includes(name))
            throw new Error(
              "Server authorization is required. Check the connection and retry.",
            );
        }
      }
      await loadEvalToolMetadata(
        { ...metadataTarget, serverIds: ids },
        loadServerMetadata,
        true,
      );
    },
    [
      metadataTarget,
      loadServerMetadata,
      ensureServersReady,
      serverActions,
      projectServers,
    ],
  );
  useEffect(() => {
    if (!suite) return;
    void loadEvalToolMetadata(metadataTarget, loadServerMetadata);
  }, [Boolean(suite), metadataTarget, loadServerMetadata]);
  const previousMetadataConnections = useRef(connectedSuiteServerKey);
  useEffect(() => {
    const previous = previousMetadataConnections.current.split("|");
    previousMetadataConnections.current = connectedSuiteServerKey;
    const connected = connectedSuiteServerKey
      .split("|")
      .filter((id) => id && !previous.includes(id));
    if (connected.length)
      void loadEvalToolMetadata(
        { ...metadataTarget, serverIds: connected },
        loadServerMetadata,
        true,
      );
  }, [connectedSuiteServerKey, metadataTarget, loadServerMetadata]);
  useEffect(() => {
    setAvailableTools(toolsMetadataState.tools);
  }, [toolsMetadataState]);

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

  /**
   * The Evaluate surface has ONE chrome for every case: the workspace. It used
   * to mount only for `isSimpleCaseShape`, so every CLI- and SDK-authored case
   * (checks stored as assert steps) fell through to the old page. The form now
   * renders those checks, and the deep step list lives inside the same
   * workspace, so neither the shape nor the deep toggle swaps the page.
   */
  const useWorkspace = Boolean(simpleCaseEditorEnabled && editForm);
  /**
   * The spine replaces the form, the Steps hatch AND the header gear at once —
   * a case cannot be half on it, because the gear's envelope writer and the
   * spine's would disagree about which surface owns `replace`.
   */
  const useSpine = useWorkspace && observeFirst;

  /**
   * Whether this deployment accepts a role on a check.
   *
   * Three states, and two of them behave identically: `unavailable` (the query
   * was refused) and `loading` both render the read-only chip, which is the
   * page exactly as it was before roles existed. A settings surface that
   * offered the control while it could not know is worse than one that waits.
   */
  const caseCapabilities = useSuiteCapabilities(
    useWorkspace ? (suiteId ?? null) : null,
  );

  /**
   * The tool question as shown, resolved from the stored choice plus what the
   * case carries. `"unset"` is the only answer that blocks: a brand-new draft
   * that asserts nothing would pass vacuously, and the backend rejects it
   * (`POSITIVE_TEST_NO_ASSERTION`).
   */
  const workspaceToolsQuestion = useMemo(() => {
    if (!useWorkspace || !editForm) return null;
    // A model-free case (a pinned `toolCall` render check) has no model turn
    // for a route claim to be about, and the form locks the question for it.
    // Asking it anyway would block Save on a shape that used to save fine —
    // the old page never showed this question at all.
    if (isModelFree(editForm.steps)) return null;
    return resolveToolsQuestion({
      choice: simpleToolsChoice,
      hasToolAsserts: editForm.steps.some(isToolCalledWithAssert),
      hasOwnAssertion: caseHasOwnAssertion({
        steps: editForm.steps,
        expectedOutput: editForm.expectedOutput,
        predicates: editForm.predicates,
      }),
    });
  }, [useWorkspace, editForm, simpleToolsChoice]);

  /**
   * Negative is what the author CHOSE, never an inference from step shape.
   * Deriving it (see `deriveIsNegativeTestFromSteps`, still used by /evals)
   * reads "no toolCalledWith assert" as "expects no tools", which is true of
   * every case whose route check is a `firstToolWas` step — flipping positive
   * CLI cases to negative on save and failing them on the route at run time.
   */
  const workspaceIsNegative = workspaceToolsQuestion === "noTool";
  const simpleToolsBlock =
    workspaceToolsQuestion === "unset" ? UNSET_TOOLS_BLOCK_REASON : null;

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

    // What THIS editor would save as the negative flag. On the workspace that
    // is the author's answer to the tool question; on /evals it stays derived.
    // Using the derivation on the workspace would mark every positive CLI case
    // dirty the moment it opened, and offer a Save that flips its flag.
    const effectiveNegativeFlag = useWorkspace
      ? workspaceIsNegative
      : deriveIsNegativeTestFromSteps(currentSteps);
    const serverNegativeFlagMismatch =
      (currentTestCase.isNegativeTest ?? false) !== effectiveNegativeFlag;

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
    const normalizedExpectedOutput = (editForm.expectedOutput ?? "").trim();
    const normalizedCurrentExpectedOutput = (
      currentTestCase.expectedOutput ?? ""
    ).trim();
    const formKind = editForm.kind ?? null;
    const currentKind = currentTestCase.kind ?? null;
    const normalizedJudgeOverride = JSON.stringify(
      normalizeForComparison(editForm.judgeConfigOverride ?? null),
    );
    const normalizedCurrentJudgeOverride = JSON.stringify(
      normalizeForComparison(currentTestCase.judgeConfigOverride ?? null),
    );

    return (
      editForm.title !== currentTestCase.title ||
      editForm.runs !== currentTestCase.runs ||
      normalizedScenario !== normalizedCurrentScenario ||
      normalizedSteps !== normalizedCurrentSteps ||
      normalizedAdvancedConfig !== normalizedCurrentAdvancedConfig ||
      normalizedMatchOptions !== normalizedCurrentMatchOptions ||
      normalizedPredicates !== normalizedCurrentPredicates ||
      normalizedExpectedOutput !== normalizedCurrentExpectedOutput ||
      formKind !== currentKind ||
      normalizedJudgeOverride !== normalizedCurrentJudgeOverride ||
      serverNegativeFlagMismatch
    );
  }, [
    editForm,
    currentAdvancedConfig,
    currentSteps,
    currentTestCase,
    useWorkspace,
    workspaceIsNegative,
  ]);
  // ── suggestions ────────────────────────────────────────────────────────────
  const suggestionBatch = useMemo(
    () => groupCaseIterations(recentIterations)[0] ?? null,
    [recentIterations],
  );
  /**
   * The coverage line under each chain card, and the suggestions it counts.
   *
   * Derived here, at the top level, because both the card below the scorecard
   * and the chain above it must read ONE list — a chain that says "2
   * suggested" while the card shows three is worse than a chain that says
   * nothing.
   */
  const chainCoverageInput = useMemo<CaseScorecardInput>(
    () => ({
      steps: editForm?.steps ?? [],
      toolsChoice: simpleToolsChoice,
      kind: editForm?.kind,
      matchOptions: editForm?.matchOptions,
      suiteDefaultMatchOptions: suite?.defaultMatchOptions,
      predicates: editForm?.predicates,
      suiteDefaultPredicates: (suite?.defaultPredicates ?? []) as Predicate[],
      expectedOutput: editForm?.expectedOutput,
      judgeConfigOverride: editForm?.judgeConfigOverride,
      suiteJudgeConfig: suite?.judgeConfig,
      suiteJudgeRubric: suite?.judgeRubric,
      numbering: "action",
    }),
    [editForm, simpleToolsChoice, suite],
  );
  const chainSuggestions = useSuggestedScorers({
    enabled: useSpine,
    batch: suggestionBatch,
    authored: chainCoverageInput,
    prompts: (editForm?.steps ?? [])
      .filter((step) => step.kind === "prompt")
      .map((step) => ("prompt" in step ? step.prompt : "")),
  });
  const chainDetailByStage = useMemo(
    () =>
      coverageDetailByStage(
        buildCaseScorecard(chainCoverageInput),
        chainSuggestions.output.suggestions,
      ),
    [chainCoverageInput, chainSuggestions.output.suggestions],
  );

  const [dismissedSuggestions, setDismissedSuggestions] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [acceptedSuggestions, setAcceptedSuggestions] = useState<
    ReadonlySet<string>
  >(() => new Set());

  /**
   * Accept one or more suggestions, in ONE draft update.
   *
   * "Add all" cannot be a loop of single accepts: `editFormStepsRef` only
   * refreshes after a render, so the second insert would compute its anchor
   * from the pre-insert list and the two would collide. Folding them means a
   * later anchor still resolves against the steps the earlier one produced.
   */
  const acceptSuggestions = useCallback(
    (list: Suggestion[], via: "row" | "all" | "chain") => {
      if (list.length === 0) return;
      const batchKey = suggestionBatch?.key ?? "";
      setEditForm((current) => {
        if (!current) return current;
        let steps = current.steps;
        let predicates = current.predicates;
        for (const suggestion of list) {
          if (suggestion.kind === "route" && suggestion.route) {
            // "No tool should be called" is a CASE-LEVEL claim, not a step.
            // `adoptRouteFromIteration` only removes tool assertions for an
            // empty observed route, which leaves the case unrestricted — the
            // row said "Added" while nothing was saved. The tool question is
            // what carries it, and it is what `buildSavePayload` reads to send
            // `isNegativeTest`.
            if (suggestion.route.noTool) {
              setSimpleToolsChoice("noTool");
            } else {
              setSimpleToolsChoice("tools");
            }
            const iteration = recentIterations.find(
              (it) => it._id === suggestion.route!.iterationId,
            );
            if (iteration) {
              steps = adoptRouteFromIteration(
                steps,
                iteration,
                deriveCaseKind(
                  resolveMatchOptions(
                    suite?.defaultMatchOptions,
                    current.matchOptions,
                  ),
                ),
              );
            }
            continue;
          }
          if (suggestion.placement.kind === "afterStep") {
            const anchor = suggestion.placement.anchorStepId;
            const assertion =
              suggestion.predicate ?? suggestion.widgetAssertion;
            if (!assertion) continue;
            // The anchor came from the trial's frozen snapshot; a draft edited
            // since may no longer contain it. A turn-scoped check still means
            // something as a whole-run check, so it falls back rather than
            // being dropped; a widget assertion does not, and is skipped.
            if (!steps.some((step) => step.id === anchor)) {
              if (suggestion.predicate) {
                predicates = appendCaseScorer(predicates, suggestion.predicate);
              }
              continue;
            }
            steps = insertStepAfter(steps, anchor, {
              id: newStepId("assert"),
              kind: "assert",
              assertion,
            } as TestStep);
            continue;
          }
          if (suggestion.predicate) {
            predicates = appendCaseScorer(predicates, suggestion.predicate);
          }
        }
        return { ...current, steps, predicates };
      });
      setAcceptedSuggestions((current) => {
        const next = new Set(current);
        for (const suggestion of list) {
          next.add(`${batchKey}|${suggestion.key}`);
        }
        return next;
      });
      for (const suggestion of list) {
        track("eval_suggestion_accepted", {
          kind: suggestion.predicate?.type ?? suggestion.kind,
          role: suggestion.role,
          stability_held: suggestion.stability.held,
          stability_of: suggestion.stability.of,
          placement: suggestion.placement.kind,
          stage: suggestion.stage,
          via,
        });
      }
    },
    [suggestionBatch?.key, recentIterations, suite?.defaultMatchOptions],
  );

  const dismissSuggestion = useCallback(
    (suggestion: Suggestion) => {
      const batchKey = suggestionBatch?.key ?? "";
      setDismissedSuggestions((current) =>
        new Set(current).add(`${batchKey}|${suggestion.key}`),
      );
      track("eval_suggestion_dismissed", {
        kind: suggestion.predicate?.type ?? suggestion.kind,
        role: suggestion.role,
        placement: suggestion.placement.kind,
        stage: suggestion.stage,
      });
    },
    [suggestionBatch?.key],
  );

  /** Save the current draft before launching a judged, case-scoped run. */
  const [runTestPending, setRunTestPending] = useState(false);
  /**
   * `handleSave` closes over `editForm` and is rebuilt every render, so the
   * copy captured by a memoized callback goes stale the moment the deps stop
   * changing — which they do as soon as `hasUnsavedChanges` flips true. Run
   * test then saved the draft as it stood at the FIRST edit and ran that,
   * while the pane showed the latest. A ref always holds the current one.
   */
  const handleSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const runTest = useCallback(async () => {
    const caseId = currentTestCase?._id;
    if (!onRunCase || !caseId || isDraft) return;
    setRunTestPending(true);
    try {
      if (hasUnsavedChanges) {
        // A refused save (an unset tool question, an invalid step list) must
        // not launch: the run executes the PERSISTED case, so it would grade
        // a version of the case the author is not looking at.
        const saved = await handleSaveRef.current?.();
        if (!saved) return;
      }
      await onRunCase(caseId, {
        iterationOverride,
        skipJudge:
          editForm?.judgeConfigOverride?.goalCompletion?.enabled === false,
      });
    } finally {
      setRunTestPending(false);
    }
  }, [
    onRunCase,
    currentTestCase?._id,
    isDraft,
    hasUnsavedChanges,
    iterationOverride,
    editForm?.judgeConfigOverride?.goalCompletion?.enabled,
  ]);

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

  /**
   * Step-authored checks are editable in the workspace form now, so an empty
   * needle or tool name can be typed there. Gate on it the way case predicates
   * are gated — workspace only, so /evals keeps saving inline asserts exactly
   * as it does today.
   */
  const areStepChecksValid = useMemo(() => {
    if (!useWorkspace || !editForm) return true;
    return areAllChecksValid(
      readStepChecks(editForm.steps).map((check) => check.predicate),
    );
  }, [useWorkspace, editForm]);

  const savePrimaryDisabled =
    !arePromptTurnsValid ||
    !arePredicatesValid ||
    !areStepChecksValid ||
    isRunningCompare ||
    isSavingDraft ||
    Boolean(simpleToolsBlock);

  const saveDisabledTooltip = useMemo(() => {
    if (!savePrimaryDisabled) {
      return null;
    }
    if (isRunningCompare) {
      return "Wait for the current run to finish before saving.";
    }
    if (simpleToolsBlock) {
      return simpleToolsBlock;
    }
    if (!arePromptTurnsValid && editForm) {
      return getStepsBlockReason(editForm.steps);
    }
    if (!arePredicatesValid || !areStepChecksValid) {
      return "Fix invalid checks before saving.";
    }
    return null;
  }, [
    savePrimaryDisabled,
    isRunningCompare,
    arePromptTurnsValid,
    arePredicatesValid,
    editForm,
    simpleToolsBlock,
  ]);

  // Pre-run credit estimate for the editor's Run / Run compare button. Priced
  // against the models the button will ACTUALLY execute (`selectedModelValues`,
  // which can differ from the saved case's configured list) and against the
  // in-editor draft's size, so it tracks unsaved prompt edits.
  // Filtered and deduped like the per-case surfaces: the run path drops
  // unparseable values (`filter(Boolean)` / `buildSelectedCompareModels`), so
  // the estimate must price exactly the same set.
  const draftRunEstimateModels = useMemo(
    () =>
      Array.from(
        new Map(
          selectedModelValues
            .map((modelValue) => parseModelValue(modelValue))
            .filter(
              (parsed) => Boolean(parsed.provider) && Boolean(parsed.model),
            )
            .map(
              (parsed) =>
                [`${parsed.provider}/${parsed.model}`, parsed] as const,
            ),
        ).values(),
      ),
    [selectedModelValues],
  );
  const draftRunEstimateHeuristic = useMemo(() => {
    const steps = editForm?.steps ?? [];
    let promptChars = 0;
    let stepCount = 0;
    for (const step of steps) {
      if (step.kind === "prompt") {
        promptChars += step.prompt?.length ?? 0;
        stepCount += 1;
      }
    }
    return { promptChars, stepCount: Math.max(1, stepCount) };
  }, [editForm?.steps]);

  const runPrimaryDisabled =
    isDraft ||
    // A model-free render check has no editor quick-run path — it runs with the
    // full suite (the compare path below would abort on "no model"). Disable
    // Run for it with an explanatory tooltip instead of letting it fail.
    casePinnedOnly ||
    selectedModelValues.length === 0 ||
    isRunningCompare ||
    !canRun ||
    !arePromptTurnsValid ||
    !areStepChecksValid ||
    Boolean(simpleToolsBlock);

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
    if (simpleToolsBlock) {
      return simpleToolsBlock;
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
    simpleToolsBlock,
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

  // Mirrors `editForm` itself (not just its steps) so the agent command
  // handler below can tell "no case is open" apart from "a case with zero
  // steps is open" — registered once at mount, so it must read live state
  // through a ref rather than close over a stale `editForm`.
  const editFormRef = useRef(editForm);
  useEffect(() => {
    editFormRef.current = editForm;
  }, [editForm]);

  const evalAgent = useEvalAgentDraft({
    // Evaluate owns the suite bridge used by scoped tools. The legacy editor
    // continues to use its existing general-agent command bridge below.
    projectId: simpleCaseEditorEnabled ? projectId : null,
    suiteId,
    suiteName: suite?.name ?? "Eval suite",
    caseId: selectedTestCaseId,
    draft: editForm,
    setDraft: setEditForm,
    tools: toolsMetadataState.tools,
    metadata: toolsMetadataState,
    retryTools: retryToolsMetadata,
    autoOpen:
      draftKind === "describe" && !deepEditor && !liveRecordMode && !checksPage,
  });

  // `ui_edit_eval_case_draft` (client/src/lib/webmcp/groups/evals.ts): lets
  // the MCPJam agent write into whatever case this editor currently has
  // open — the same prompt/tool-assertion shape the Describe workspace and
  // SimpleCaseForm already write through `writeSimpleCase`. Scoped to this
  // component's own mount lifecycle (not the shared `useSurfaceAgentBridge`
  // call, which belongs to EvalsTab for the whole /evals surface) so the
  // tool only works while a case editor is actually on screen.
  useEffect(() => {
    return registerInspectorCommandHandler("editEvalCaseDraft", (command) => {
      const current = editFormRef.current;
      if (!current) {
        throw createInspectorCommandClientError(
          "unsupported_in_mode",
          "No test case is currently open for editing. Open or create a case first.",
        );
      }
      const { payload } = command as EditEvalCaseDraftInspectorCommand;
      const simple = readSimpleCase(current.steps);
      const nextTools: Array<{
        id?: string;
        toolName: string;
        arguments?: Record<string, unknown>;
      }> = payload.addToolAssertion
        ? [
            ...simple.tools,
            {
              toolName: payload.addToolAssertion.toolName,
              arguments: payload.addToolAssertion.arguments ?? {},
            },
          ]
        : simple.tools;
      const nextPrompt =
        payload.prompt !== undefined ? payload.prompt : simple.prompt;
      const nextNoTool =
        payload.noTool !== undefined ? payload.noTool : simple.noTool;
      const nextSteps = writeSimpleCase(current.steps, {
        prompt: nextPrompt,
        tools: nextTools,
        noTool: nextNoTool,
      });
      setEditForm((prev) => (prev ? { ...prev, steps: nextSteps } : prev));
      return {
        status: "updated",
        prompt: nextPrompt,
        toolAssertionCount: nextTools.length,
        noTool: nextNoTool,
      };
    });
  }, []);

  // Append a recorder-captured widget step (interact or assert) to the END of
  // turn `turnIndex`'s block in the flat step list. The recorder reports a
  // turn-granular `promptIndex`; `stepTurnIndices` maps each step to its
  // implicit turn, so we splice in right after that turn's last step (or append
  // to the end if that turn has no steps yet).
  const appendWidgetStepToTurn = useCallback(
    (turnIndex: number, step: TestStep) => {
      const currentSteps = editFormStepsRef.current;
      // `lastStepIdOfTurn` names the turn's last step and `insertStepAfter`
      // puts the recorded step right behind it — the same position the local
      // reverse scan produced, pinned against that loop by a property test in
      // `shared/__tests__/steps-spine.test.ts`. When the turn has no steps yet
      // (or does not exist), the fallback anchors on the list's last step,
      // which appends, as before.
      const next = insertStepAfter(
        currentSteps,
        lastStepIdOfTurn(currentSteps, turnIndex) ??
          currentSteps[currentSteps.length - 1]?.id ??
          null,
        step,
      );
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
          id: newStepId("wassert"),
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
      const saved =
        shouldSaveLiveRecorderStep(event) && turnIndex < authoredTurns;
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
        id: newStepId("interact"),
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
    // On the workspace the author answers the tool question outright. Only the
    // legacy /evals editor, which has no such control, still infers the flag
    // from step shape — an inference that reads every `firstToolWas`-only case
    // as "expects no tools".
    const isNegativeTest = useWorkspace
      ? workspaceIsNegative
      : deriveIsNegativeTestFromSteps(form.steps);
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
      // Authored rubric for the model judge. Send "" to clear — the backend
      // preserves the field on omit, and the judge trims "" to absent.
      expectedOutput: form.expectedOutput?.trim() ?? "",
      steps,
      isNegativeTest,
      advancedConfig: normalizeAdvancedConfig(form.advancedConfig),
      matchOptions: form.matchOptions,
      predicates: normalizedPredicates,
      // Omitted when undefined: `createTestCase` admits no `null` for this
      // field, and `handleSave` supplies the null-clear on the update path.
      ...(form.judgeConfigOverride !== undefined
        ? { judgeConfigOverride: form.judgeConfigOverride }
        : {}),
      ...(form.kind !== undefined ? { kind: form.kind } : {}),
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

    if (simpleToolsBlock) {
      setSimpleValidationAttempted(true);
      toast.error(simpleToolsBlock);
      return false;
    }

    if (!validateSteps(editForm.steps)) {
      toast.error(
        getStepsBlockReason(editForm.steps) ??
          "Fix the test configuration before saving.",
      );
      return false;
    }

    setIsSavingDraft(true);
    try {
      const savePayload = buildSavePayload(editForm);
      const newTestCaseId = await createTestCaseMutation({
        suiteId,
        models: currentTestCase?.models ?? [],
        // Mint the case's DECLARED identity here — callers mint, the platform
        // validates. It lands in `declaredCaseId`; the row's storage `caseKey`
        // stays the platform's own random `ui_*` value and is untouched.
        caseId: mintCaseId(),
        ...savePayload,
      });
      track("eval_test_case_created", {
        location: "test_template_editor",
        suite_id: suiteId ?? null,
        test_case_id: newTestCaseId,
        num_models: currentTestCase?.models?.length ?? 0,
        num_steps: editForm.steps?.length ?? 0,
      });
      toast.success("Test case created");
      if (simpleCaseEditorEnabled && projectId) {
        promoteEvalDraftChat(
          {
            projectId,
            suiteId,
            suiteName: suite?.name ?? "Eval suite",
            caseId: selectedTestCaseId,
          },
          newTestCaseId,
        );
      }
      onDraftSaved?.(newTestCaseId);
    } catch (error) {
      console.error("Failed to create test case:", error);
      toast.error(getBillingErrorMessage(error, "Failed to create test case"));
      throw error;
    } finally {
      setIsSavingDraft(false);
    }
  };

  /**
   * Returns whether the draft was actually persisted.
   *
   * It refuses on its own validation — an unset tool question, an invalid step
   * list — and used to do so by returning normally, which reads as success to
   * anything that awaits it. "Run test" awaited it and launched the PREVIOUSLY
   * saved case, so a refused save silently ran something the author was not
   * looking at.
   */
  const handleSave = async (): Promise<boolean> => {
    if (isDraft) {
      await handleCreateFromDraft();
      return true;
    }
    if (!editForm || !currentTestCase) return false;

    if (simpleToolsBlock) {
      setSimpleValidationAttempted(true);
      toast.error(simpleToolsBlock);
      return false;
    }

    if (!validateSteps(editForm.steps)) {
      toast.error(
        getStepsBlockReason(editForm.steps) ??
          "Fix the test configuration before saving.",
      );
      return false;
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
        // And for the judge opt-out, so turning the switch back off actually
        // removes the stored override rather than leaving it in place.
        judgeConfigOverride: savePayload.judgeConfigOverride ?? null,
      });
      track("eval_test_case_edited", {
        location: "test_template_editor",
        suite_id: suiteId ?? null,
        test_case_id: currentTestCase._id,
        num_models: currentTestCase.models?.length ?? 0,
        num_steps: editForm.steps?.length ?? 0,
        has_match_options: savePayload.matchOptions != null,
        has_predicates: savePayload.predicates != null,
      });
      toast.success("Changes saved");
      return true;
    } catch (error) {
      console.error("Failed to save:", error);
      toast.error(getBillingErrorMessage(error, "Failed to save changes"));
      throw error;
    }
  };
  // Kept current so `runTest` never awaits a save built from a stale draft.
  handleSaveRef.current = handleSave;

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
            judgeConfigOverride: savePayload.judgeConfigOverride ?? null,
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
        : (selectedModelValues[0] ?? null),
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
          : (selectedModelValues[0] ?? null),
      );
      track("compare_run_view_opened", {
        location: "test_template_editor",
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

    if (simpleToolsBlock) {
      setSimpleValidationAttempted(true);
      toast.error(simpleToolsBlock);
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
        ? (activeCompareRunId ?? latestHistoricalCompareRunId)
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
            // The workspace owns the count (saved with the case, edited in the
            // Next run sheet); only the old page has the per-run override.
            runs: useWorkspace
              ? (editForm.runs ?? DEFAULTS.RUNS_PER_TEST)
              : iterationOverride,
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
    // On the workspace the run opens on its Scorecard — the question a person
    // pressed Run to answer. The interact/assert heuristic below stays for
    // /evals, which has no scorecard to open on.
    const defaultRunColumnTab: RunColumnTab = useWorkspace
      ? "scorecard"
      : normalizeSteps(savePayload.steps).some(
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
      const launchSnapshot = {
        steps: savePayload.steps,
        predicates: savePayload.predicates,
        matchOptions: savePayload.matchOptions,
        expectedOutput: savePayload.expectedOutput,
        isNegativeTest: savePayload.isNegativeTest,
        runs: useWorkspace
          ? (editForm.runs ?? DEFAULTS.RUNS_PER_TEST)
          : iterationOverride,
        namedHostId: quickRunHostPlan.namedHostId,
      };
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
          attemptId: createAttemptId(),
          launchSnapshot: { ...launchSnapshot, modelValue },
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
    setInspectIterationId(null);
    setMissingAppEvidenceStepId(null);
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

    track("compare_run_started", {
      location: "test_template_editor",
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
                      // Carried across the gap before the persisted blob loads,
                      // so the Replay filmstrip doesn't blink out at completion.
                      streamingLiveBrowserSteps:
                        previous[modelValue]?.streamingLiveBrowserSteps,
                      streamingLiveBrowserFrameSequence:
                        previous[modelValue]?.streamingLiveBrowserFrameSequence,
                    },
                  }));

                  track("compare_model_completed", {
                    location: "test_template_editor",
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
                      // A run that FAILED is exactly when you want to see what
                      // the browser was doing — don't drop the frames with it.
                      streamingLiveBrowserSteps:
                        existing?.streamingLiveBrowserSteps,
                      streamingLiveBrowserFrameSequence:
                        existing?.streamingLiveBrowserFrameSequence,
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
                      liveBrowserSteps:
                        existing.streamingLiveBrowserSteps ?? [],
                      liveBrowserFrameSequence:
                        existing.streamingLiveBrowserFrameSequence ?? 0,
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
                      streamingLiveBrowserSteps: streamState.liveBrowserSteps,
                      streamingLiveBrowserFrameSequence:
                        streamState.liveBrowserFrameSequence,
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
                  streamingLiveBrowserSteps:
                    existing?.streamingLiveBrowserSteps,
                  streamingLiveBrowserFrameSequence:
                    existing?.streamingLiveBrowserFrameSequence,
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

            track("compare_model_completed", {
              location: "test_template_editor",
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
    track("compare_run_tab_changed", {
      location: "test_template_editor",
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

  const inspectIteration =
    inspectIterationId == null
      ? null
      : ([
          replayIteration,
          routeCompareAnchorIteration,
          ...recentIterations,
        ].find((it) => it?._id === inspectIterationId) ?? null);
  const workspaceDraft = {
    steps: editForm?.steps,
    predicates: resolveCasePredicates(
      (suite?.defaultPredicates ?? []) as Predicate[],
      editForm?.predicates,
    ),
    matchOptions: resolveMatchOptions(
      suite?.defaultMatchOptions,
      editForm?.matchOptions,
    ),
    expectedOutput: editForm?.expectedOutput ?? "",
    isNegativeTest: simpleToolsChoice === "noTool",
  };
  const workspacePaneView = paneViewFor({
    explicit: replayIteration
      ? {
          iteration: replayIteration,
          source:
            replayIteration._id === routeCompareAnchorIteration?._id
              ? "route"
              : "history",
        }
      : null,
    liveRecordMode,
    showLive: showRunInPreview,
    liveRecord: previewRecord,
    latestCandidates: [
      routeCompareAnchorIteration,
      ...recentIterations,
      lastSavedIteration,
    ],
    specTrace: specPreviewTrace,
    showSpecOverride,
  });
  const workspaceSelectedTrial: SelectedTrial | null =
    workspacePaneView.kind === "trial" ? workspacePaneView.trial : null;
  const workspaceLeftView = leftViewFor({
    inspect: useSpine ? null : inspectIteration,
    draft: workspaceDraft,
    selected: workspaceSelectedTrial,
  });
  const workspaceOverlayTrial =
    workspaceLeftView.kind === "editing"
      ? workspaceLeftView.overlay?.trial
      : null;
  const workspaceOverlayIteration = selectedTrialIteration(
    workspaceOverlayTrial ?? null,
  );
  // Narrowed once here: TypeScript does not carry a discriminant narrowed on
  // `workspacePaneView.trial.kind` into the JSX callbacks below.
  const workspaceLiveRecord =
    workspacePaneView.kind === "trial" &&
    workspacePaneView.trial.kind === "live"
      ? workspacePaneView.trial.record
      : null;
  const workspacePersistedIteration =
    workspacePaneView.kind === "trial" &&
    workspacePaneView.trial.kind === "persisted"
      ? workspacePaneView.trial.iteration
      : null;
  const workspaceOverlay = workspaceOverlayIteration
    ? {
        stepStatusById: parseStepStatusById(
          workspaceOverlayIteration.metadata as
            Parameters<typeof parseStepStatusById>[0] | undefined,
        ),
      }
    : null;
  /**
   * Per-step verdicts for the workspace's deep step list, gated exactly like
   * the form's overlay — only while the selected trial still matches the
   * draft, so a stale run never paints ticks onto edited steps. The persisted
   * map wins once it lands; `parseStepStatusById` returns an EMPTY map (never
   * undefined) for an iteration with no per-step metadata, so fall back on
   * `.size`, not on nullishness.
   */
  const workspaceStepStatusById = workspaceOverlayTrial
    ? (workspaceOverlay?.stepStatusById?.size ?? 0) > 0
      ? workspaceOverlay?.stepStatusById
      : liveStepStatusById
    : undefined;
  const workspaceStepStatusByTurn =
    workspaceOverlayTrial?.kind === "live" ? liveStepStatusByTurn : undefined;
  /**
   * "Inspecting <trial>" banner, shared by both left-column editors: the form
   * hosts it in `inspectHeader`, the deep step list in its own pane header.
   */
  const workspaceInspectStrip =
    workspaceLeftView.kind === "inspecting" ? (
      <InspectStrip
        iteration={workspaceLeftView.iteration}
        edited={capturedCaseChanged(
          workspaceDraft,
          workspaceLeftView.iteration.testCaseSnapshot,
        )}
        onEditCase={() => setInspectIterationId(null)}
      />
    ) : null;
  const workspaceInspectSteps =
    workspaceLeftView.kind === "inspecting"
      ? caseViewModel(
          "historical",
          workspaceLeftView.iteration.testCaseSnapshot,
        ).steps
      : undefined;
  /**
   * The chain for the selected trial, as an object rather than a slot.
   *
   * `trialChainSlotFor` renders it; the scorecard's route row needs to READ
   * it, because on a run with no score rows the analyzer's selection verdict
   * is the only fact about whether the route held.
   *
   * A plain const, not a `useMemo`: everything in this region runs after the
   * component's early return for a missing case, so a hook here would change
   * the hook count between renders. `TrialScorecard` memoizes its own build.
   */
  const workspaceTrialChain = (() => {
    const iteration = workspacePersistedIteration;
    if (!iteration || !chainSlotEnabled) return null;
    if (iteration.suiteRunId) {
      return trialChains.chains.get(iteration._id) ?? null;
    }
    const live =
      recentIterations.find((it) => it._id === iteration._id) ?? iteration;
    return chainForQuickRunIteration(live);
  })();

  /** What the LEFT pane is showing, as the scorecard model's input. */
  const workspaceDraftScorecardInput = {
    numbering: useSpine ? ("action" as const) : ("flat" as const),
    steps: editForm?.steps ?? [],
    toolsChoice: simpleToolsChoice,
    kind: editForm?.kind,
    matchOptions: editForm?.matchOptions,
    suiteDefaultMatchOptions: suite?.defaultMatchOptions,
    predicates: editForm?.predicates,
    suiteDefaultPredicates: (suite?.defaultPredicates ?? []) as Predicate[],
    expectedOutput: editForm?.expectedOutput,
    judgeConfigOverride: editForm?.judgeConfigOverride,
    suiteJudgeConfig: suite?.judgeConfig,
    suiteJudgeRubric: suite?.judgeRubric,
  };

  const workspaceTrialRun = selectedTrialIteration(workspaceSelectedTrial)
    ?.suiteRunId
    ? (suiteRuns.find(
        (run) =>
          run._id ===
          selectedTrialIteration(workspaceSelectedTrial)?.suiteRunId,
      ) ?? null)
    : null;

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
      {simpleCaseEditorEnabled && editForm && evalAgent.change && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs">
          <span className="text-muted-foreground" aria-live="polite">
            {evalAgent.change
              ? `Draft updated: ${evalAgent.change.fields.join(
                  ", ",
                )}. Review before saving.`
              : "Edit the case or refine it with Ask MCPJam."}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {evalAgent.change && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!evalAgent.canUndo}
                onClick={() => {
                  try {
                    getEvalDraft(evalAgent.scope).undo(
                      evalAgent.change!.revision,
                    );
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Could not undo edit",
                    );
                  }
                }}
              >
                Undo
              </Button>
            )}
            {draftKind === "describe" && (
              <Button size="sm" variant="outline" onClick={evalAgent.open}>
                Ask MCPJam
              </Button>
            )}
          </div>
        </div>
      )}
      {/* Assert-mode pick chooser: opens when a click is captured in "Add
          checks" mode, builds a widget assertion seeded with the derived
          locator. Portaled, so its position here doesn't affect layout. */}
      <AssertPickChooser
        pick={pendingPick}
        onConfirm={handleAssertPickConfirm}
        onCancel={() => setPendingPick(null)}
      />
      {checksPage && editForm ? (
        <CaseChecksPage
          title={editForm.title}
          disabledChecks={suite?.disabledStageChecks}
          predicates={editForm.predicates}
          suitePredicates={(suite?.defaultPredicates ?? []) as Predicate[]}
          availableTools={assertableTools.map((tool) =>
            typeof tool === "string" ? tool : tool.name,
          )}
          onPredicatesChange={(predicates) =>
            setEditForm((current) =>
              current ? { ...current, predicates } : current,
            )
          }
          judgeSkipped={
            editForm.judgeConfigOverride?.goalCompletion?.enabled === false
          }
          onJudgeSkippedChange={(skipped) =>
            setEditForm((current) =>
              current
                ? {
                    ...current,
                    judgeConfigOverride: withCaseJudgeSkipped(
                      current.judgeConfigOverride,
                      skipped,
                    ),
                  }
                : current,
            )
          }
          onSave={() => void handleSave()}
          saveDisabled={savePrimaryDisabled}
          onBack={onCloseCaseChecks}
          onConfigureSuite={onOpenSuiteSettings}
        />
      ) : draftKind === "describe" &&
        editForm &&
        !deepEditor &&
        !liveRecordMode ? (
        <DescribeCaseWorkspace
          title={editForm.title}
          onTitleChange={(title) =>
            setEditForm((current) =>
              current ? { ...current, title } : current,
            )
          }
          onAsk={evalAgent.open}
          onSave={() => void handleSave()}
          saveDisabled={savePrimaryDisabled}
          caseForm={
            <CaseSpine
              steps={editForm.steps}
              onStepsChange={setSteps}
              matchOptions={editForm.matchOptions}
              onMatchOptionsChange={(next) =>
                setEditForm((current) =>
                  current ? { ...current, matchOptions: next } : current,
                )
              }
              expectedOutput={editForm.expectedOutput}
              onExpectedOutputChange={(next) =>
                setEditForm((current) =>
                  current ? { ...current, expectedOutput: next } : current,
                )
              }
              predicates={editForm.predicates}
              onPredicatesChange={(next) =>
                setEditForm((current) =>
                  current ? { ...current, predicates: next } : current,
                )
              }
              availableTools={assertableTools}
              suiteServers={effectiveSuiteServers}
              projectServers={projectServers}
              suiteDefaultPredicates={
                (suite?.defaultPredicates ?? []) as Predicate[]
              }
              suiteDefaultMatchOptions={suite?.defaultMatchOptions}
              capabilities={caseCapabilities.capabilities}
              defaultChecks={
                <DefaultChecksReference
                  disabledChecks={suite?.disabledStageChecks}
                  onConfigureSuite={onOpenSuiteSettings}
                  onOverride={onOpenCaseChecks}
                />
              }
            />
          }
        />
      ) : editorMode === "config" ? (
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
                    className="min-w-0 w-full bg-transparent px-0 py-0 text-base font-semibold tracking-tight focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 w-full text-left"
                    onClick={handleTitleClick}
                  >
                    <h2 className="text-base font-semibold tracking-tight transition-opacity hover:opacity-80">
                      {editForm?.title || currentTestCase.title}
                    </h2>
                  </button>
                )}
                {(currentTestCase as { lastSdkWriteAt?: number })
                  ?.lastSdkWriteAt != null ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Synced from CI — the next CI report may overwrite manual
                    edits.
                  </p>
                ) : null}
                {/*
                  The converter's claim and mapping note, READ-ONLY.

                  A record of what a converter did, not a field a reviewer
                  edits: making it editable here would let somebody rewrite the
                  justification for a claim without changing the claim, which is
                  the one edit that makes the record actively misleading.
                */}
                <ImportClaimDetails
                  claim={
                    (
                      currentTestCase as {
                        import?: import("./types").EvalCaseImportClaim;
                      }
                    )?.import
                  }
                  className="mt-2"
                />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {onExportDraft && !useWorkspace ? (
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
                {/* The gear duplicated the whole check list and owned the one
                    control the spine did not have a home for (argument
                    matching). On the spine it is gone; `/evals` keeps it. */}
                {editForm && !useSpine ? (
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
                {useWorkspace ? (
                  <CaseRunSetup
                    open={runSetupOpen}
                    onOpenChange={setRunSetupOpen}
                    caseTitle={editForm?.title || currentTestCase.title}
                    onStart={handlePrimaryRun}
                    runDisabled={runPrimaryDisabled}
                    disabledReason={runDisabledTooltip}
                    models={selectedModelValues}
                    modelLabelByValue={modelLabelByValue}
                    availableModels={availableModels}
                    disabled={isRunningCompare}
                    onModelsChange={setSelectedModelValues}
                    trials={editForm?.runs ?? DEFAULTS.RUNS_PER_TEST}
                    onTrialsChange={(next) =>
                      setEditForm((current) =>
                        current ? { ...current, runs: next } : current,
                      )
                    }
                    hostLabel={
                      selectedQuickRunHostOption?.label ?? suiteHostLabel
                    }
                    hostValue={
                      quickRunHostOptions.length > 0
                        ? (quickRunHostSelection ?? "")
                        : suiteHostLabel
                    }
                    hostOptions={quickRunHostOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    onHostChange={setQuickRunHostSelection}
                  />
                ) : quickRunHostOptions.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="inline-flex cursor-pointer items-center">
                        <span className="sr-only">Client</span>
                        <span className="inline-flex h-8 max-w-[7.5rem] items-center gap-1 rounded-md border border-input/80 bg-background px-1.5">
                          <HostChipLogo
                            logoSrc={selectedQuickRunHostLogoSrc}
                            name={selectedQuickRunHostOption?.label ?? "Client"}
                            size="sm"
                          />
                          <select
                            className="min-w-0 max-w-[5.5rem] truncate bg-transparent text-xs text-foreground outline-none"
                            value={quickRunHostSelection ?? ""}
                            onChange={(event) =>
                              setQuickRunHostSelection(event.target.value)
                            }
                            aria-label="Client for the next run"
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
                      Client for the next run
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
                        aria-label="Client for the next run"
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
                      Client for the next run
                    </TooltipContent>
                  </Tooltip>
                )}
                {useWorkspace ? null : (
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
                )}
                {useWorkspace ? null : (
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
                            (liveRecordMode
                              ? " fill-destructive text-destructive"
                              : "")
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
                )}
                {runDisabledTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          onClick={() =>
                            useWorkspace
                              ? setRunSetupOpen(true)
                              : handlePrimaryRun()
                          }
                          disabled={
                            useWorkspace ? isRunningCompare : runPrimaryDisabled
                          }
                        >
                          {isRunningCompare ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Running…
                            </>
                          ) : (
                            <>
                              <Play className="size-3.5 fill-current" />
                              {useWorkspace
                                ? "Setup Run"
                                : selectedModelValues.length > 1
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
                      onClick={() =>
                        useWorkspace
                          ? setRunSetupOpen(true)
                          : handlePrimaryRun()
                      }
                      disabled={
                        useWorkspace ? isRunningCompare : runPrimaryDisabled
                      }
                    >
                      {isRunningCompare ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Running…
                        </>
                      ) : (
                        <>
                          <Play className="size-3.5 fill-current" />
                          {useWorkspace
                            ? "Setup Run"
                            : selectedModelValues.length > 1
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
                {/* Draft-run estimate: priced against the models the button will
                    execute and the CURRENT (possibly unsaved) prompt size.
                    Suppressed when the Run control can't run — an unsaved draft,
                    a render check, or no model selected. */}
                <QuickCaseRunCostEstimateHint
                  suiteId={suiteId}
                  caseId={draftKind ? null : (currentTestCase?._id ?? null)}
                  models={draftRunEstimateModels}
                  runs={iterationOverride}
                  draft={draftRunEstimateHeuristic}
                  // Mirrors `runPrimaryDisabled` for its STRUCTURAL blockers —
                  // unsaved draft, render check, no model, no suite servers,
                  // invalid steps — each of which means this Run can't launch
                  // as configured. `isRunningCompare` is deliberately excluded:
                  // that's transient, and the estimate stays accurate for the
                  // next run (same line drawn for the per-case controls, which
                  // keep the hint while servers are merely disconnected).
                  suppressed={
                    isDraft ||
                    casePinnedOnly ||
                    draftRunEstimateModels.length === 0 ||
                    !canRun ||
                    // `canRun` lets a DIRECT GUEST through with zero servers,
                    // but `handleRunCompare` still rejects with "No MCP servers
                    // are configured for this suite." — so gate on the server
                    // list itself, not just `canRun`.
                    !hasConfiguredSuiteServers ||
                    !arePromptTurnsValid
                  }
                  side="top"
                />
              </div>
            </div>
          </div>
          {useWorkspace ? (
            <>
              <CaseWorkspaceLayout
                left={
                  editForm && deepEditor && !useSpine ? (
                    // The Steps hatch stays INSIDE the workspace: same trial on
                    // the right, one click back. It used to swap the whole page
                    // for the old editor with no way back until the case
                    // changed.
                    <WorkspaceStepsPane
                      header={workspaceInspectStrip}
                      onBackToForm={() => setDeepEditor(false)}
                    >
                      <StepListEditor
                        protectPrompts
                        steps={workspaceInspectSteps ?? editForm.steps}
                        onStepsChange={
                          workspaceInspectSteps ? () => undefined : setSteps
                        }
                        readOnly={Boolean(workspaceInspectSteps)}
                        availableTools={assertableTools}
                        argumentMatching={
                          resolveMatchOptions(
                            suite?.defaultMatchOptions,
                            editForm.matchOptions,
                          ).argumentMatching
                        }
                        suiteServers={effectiveSuiteServers}
                        projectServers={projectServers}
                        evalValidationBorderClass={evalValidationBorderClass}
                        stepStatusByTurn={
                          workspaceInspectSteps
                            ? undefined
                            : workspaceStepStatusByTurn
                        }
                        stepStatusById={
                          workspaceInspectSteps
                            ? undefined
                            : workspaceStepStatusById
                        }
                        syncedStepId={syncedStepId}
                        onHoverStep={setSyncedStepId}
                      />
                    </WorkspaceStepsPane>
                  ) : editForm &&
                    workspaceLeftView.kind === "inspecting" &&
                    !useSpine ? (
                    <SimpleCaseForm
                      steps={workspaceInspectSteps ?? []}
                      onStepsChange={() => undefined}
                      onMatchOptionsChange={() => undefined}
                      onExpectedOutputChange={() => undefined}
                      onPredicatesChange={() => undefined}
                      expectedOutput={
                        workspaceLeftView.iteration.testCaseSnapshot
                          ?.expectedOutput
                      }
                      matchOptions={
                        workspaceLeftView.iteration.testCaseSnapshot
                          ?.matchOptions
                      }
                      availableTools={assertableTools.map((tool) =>
                        typeof tool === "string" ? tool : tool.name,
                      )}
                      readOnly
                      inspectHeader={workspaceInspectStrip}
                      onOpenDeepEditor={() => setDeepEditor(true)}
                    />
                  ) : editForm && workspaceLeftView.kind === "inspecting" ? (
                    <CaseSpine
                      key={`case-inspect:${workspaceLeftView.iteration._id}`}
                      steps={workspaceInspectSteps ?? []}
                      onStepsChange={() => undefined}
                      matchOptions={
                        workspaceLeftView.iteration.testCaseSnapshot
                          ?.matchOptions
                      }
                      onMatchOptionsChange={() => undefined}
                      expectedOutput={
                        workspaceLeftView.iteration.testCaseSnapshot
                          ?.expectedOutput
                      }
                      onExpectedOutputChange={() => undefined}
                      onPredicatesChange={() => undefined}
                      availableTools={assertableTools}
                      readOnly
                      inspectHeader={
                        <>
                          {workspaceInspectStrip}
                          {!caseViewModel(
                            "historical",
                            workspaceLeftView.iteration.testCaseSnapshot,
                          ).availability.steps && (
                            <p className="text-sm text-muted-foreground">
                              This run did not capture its case steps.
                            </p>
                          )}
                        </>
                      }
                      snapshotPredicates={
                        Array.isArray(
                          workspaceLeftView.iteration.testCaseSnapshot
                            ?.predicates,
                        )
                          ? (workspaceLeftView.iteration.testCaseSnapshot
                              .predicates as Predicate[])
                          : undefined
                      }
                      predicates={
                        Array.isArray(
                          workspaceLeftView.iteration.testCaseSnapshot
                            ?.predicates,
                        )
                          ? undefined
                          : (workspaceLeftView.iteration.testCaseSnapshot
                              ?.predicates as CasePredicates | undefined)
                      }
                      suiteJudgeConfig={
                        workspaceTrialRun?.configSnapshot?.judgeConfig
                      }
                      trialIteration={workspaceLeftView.iteration}
                      trialChain={workspaceTrialChain}
                      defaultChecks={trialChainSlotFor(
                        workspaceLeftView.iteration,
                      )}
                      syncedStepId={syncedStepId}
                      onHoverStep={setSyncedStepId}
                    />
                  ) : editForm && useSpine ? (
                    <CaseSpine
                      defaultChecks={
                        <DefaultChecksReference
                          disabledChecks={suite?.disabledStageChecks}
                          onConfigureSuite={onOpenSuiteSettings}
                          onOverride={onOpenCaseChecks}
                        />
                      }
                      key={`spine:${currentTestCase?._id ?? "none"}`}
                      steps={editForm.steps}
                      onStepsChange={setSteps}
                      matchOptions={editForm.matchOptions}
                      onMatchOptionsChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, matchOptions: next }
                            : current,
                        )
                      }
                      suiteDefaultMatchOptions={suite?.defaultMatchOptions}
                      kind={editForm.kind}
                      onKindChange={(next) =>
                        setEditForm((current) =>
                          current ? { ...current, kind: next } : current,
                        )
                      }
                      expectedOutput={editForm.expectedOutput}
                      onExpectedOutputChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, expectedOutput: next }
                            : current,
                        )
                      }
                      predicates={editForm.predicates}
                      onPredicatesChange={(next) =>
                        setEditForm((current) =>
                          current ? { ...current, predicates: next } : current,
                        )
                      }
                      suiteDefaultPredicates={
                        (suite?.defaultPredicates ?? []) as Predicate[]
                      }
                      availableTools={assertableTools}
                      suiteServers={effectiveSuiteServers}
                      projectServers={projectServers}
                      isNegativeTest={currentTestCase.isNegativeTest}
                      toolsChoice={simpleToolsChoice}
                      onToolsChoiceChange={setSimpleToolsChoice}
                      stashedTools={simpleStashedTools}
                      onStashedToolsChange={setSimpleStashedTools}
                      judgeConfigOverride={editForm.judgeConfigOverride}
                      onJudgeConfigOverrideChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, judgeConfigOverride: next }
                            : current,
                        )
                      }
                      suiteJudgeConfig={suite?.judgeConfig}
                      suiteJudgeRubric={suite?.judgeRubric}
                      capabilities={caseCapabilities.capabilities}
                      evalValidationBorderClass={evalValidationBorderClass}
                      autoFocusPrompt={draftKind === "record"}
                      validationAttempted={simpleValidationAttempted}
                      recording={liveRecordMode}
                      recordEntryPrimary={draftKind === "record"}
                      onStartRecording={() => {
                        setShowSpecOverride(false);
                        setCaptureMode("record");
                        setLiveRecordMode(true);
                      }}
                      onStopRecording={() => setLiveRecordMode(false)}
                      onAddCheck={() => setCaptureMode("assert")}
                      stepStatusById={workspaceStepStatusById}
                      stepStatusByTurn={workspaceStepStatusByTurn}
                      syncedStepId={syncedStepId}
                      onHoverStep={setSyncedStepId}
                      onSelectStep={(stepId) => {
                        setSyncedStepId(stepId);
                        const liveSteps =
                          workspaceSelectedTrial?.kind === "live"
                            ? workspaceSelectedTrial.record
                                .streamingLiveBrowserSteps
                            : undefined;
                        if (
                          workspaceSelectedTrial?.kind === "live" &&
                          (liveSteps?.length ?? 0) === 0
                        ) {
                          setMissingAppEvidenceStepId(stepId);
                        } else {
                          setMissingAppEvidenceStepId(null);
                        }
                      }}
                      runControl={
                        onRunCase ? (
                          <div>
                            <Button
                              type="button"
                              size="sm"
                              className="h-8"
                              data-testid="case-run-test"
                              disabled={
                                isDraft ||
                                runTestPending ||
                                Boolean(simpleToolsBlock)
                              }
                              onClick={() => void runTest()}
                            >
                              <Play className="size-3.5 fill-current" />
                              Run test
                            </Button>
                          </div>
                        ) : null
                      }
                    />
                  ) : editForm ? (
                    <SimpleCaseForm
                      key={`simple-case:${currentTestCase?._id ?? "none"}`}
                      steps={editForm.steps}
                      onStepsChange={setSteps}
                      matchOptions={editForm.matchOptions}
                      kind={editForm.kind}
                      onKindChange={(next) =>
                        setEditForm((current) =>
                          current ? { ...current, kind: next } : current,
                        )
                      }
                      onMatchOptionsChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, matchOptions: next }
                            : current,
                        )
                      }
                      suiteDefaultMatchOptions={suite?.defaultMatchOptions}
                      expectedOutput={editForm.expectedOutput}
                      onExpectedOutputChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, expectedOutput: next }
                            : current,
                        )
                      }
                      predicates={editForm.predicates}
                      onPredicatesChange={(next) =>
                        setEditForm((current) =>
                          current ? { ...current, predicates: next } : current,
                        )
                      }
                      suiteDefaultPredicates={
                        (suite?.defaultPredicates ?? []) as Predicate[]
                      }
                      availableTools={assertableTools.map((tool) =>
                        typeof tool === "string" ? tool : tool.name,
                      )}
                      isNegativeTest={currentTestCase.isNegativeTest}
                      onOpenDeepEditor={() => setDeepEditor(true)}
                      toolsChoice={simpleToolsChoice}
                      onToolsChoiceChange={setSimpleToolsChoice}
                      stashedTools={simpleStashedTools}
                      onStashedToolsChange={setSimpleStashedTools}
                      judgeConfigOverride={editForm.judgeConfigOverride}
                      onJudgeConfigOverrideChange={(next) =>
                        setEditForm((current) =>
                          current
                            ? { ...current, judgeConfigOverride: next }
                            : current,
                        )
                      }
                      suiteJudgeConfig={suite?.judgeConfig}
                      suiteJudgeRubric={suite?.judgeRubric}
                      capabilities={caseCapabilities.capabilities}
                      evalValidationBorderClass={evalValidationBorderClass}
                      autoFocusPrompt={draftKind === "record"}
                      validationAttempted={simpleValidationAttempted}
                      recording={liveRecordMode}
                      recordEntryPrimary={draftKind === "record"}
                      onStartRecording={() => {
                        setShowSpecOverride(false);
                        setCaptureMode("record");
                        setLiveRecordMode(true);
                      }}
                      onStopRecording={() => setLiveRecordMode(false)}
                      onAddCheck={() => setCaptureMode("assert")}
                      overlay={workspaceOverlay}
                      onSelectInAppStep={(stepId) => {
                        setSyncedStepId(stepId);
                        const liveSteps =
                          workspaceSelectedTrial?.kind === "live"
                            ? workspaceSelectedTrial.record
                                .streamingLiveBrowserSteps
                            : undefined;
                        if (
                          workspaceSelectedTrial?.kind === "live" &&
                          (liveSteps?.length ?? 0) === 0
                        ) {
                          setMissingAppEvidenceStepId(stepId);
                        } else {
                          setMissingAppEvidenceStepId(null);
                        }
                      }}
                    />
                  ) : null
                }
                history={(evidence) => (
                  <CaseRunTimeline
                    openIterationId={
                      openCompareFromRoute
                        ? null
                        : routeCompareAnchorIterationId
                    }
                    caseTitle={
                      editForm?.title ||
                      currentTestCase?.title ||
                      "Untitled test case"
                    }
                    suiteName={suite?.name}
                    liveVerdict={
                      workspaceLiveRecord && workspaceSelectedTrial
                        ? trialVerdict(workspaceSelectedTrial).word
                        : undefined
                    }
                    suiteRuns={suiteRuns}
                    hostNamesById={hostNamesById}
                    iterations={
                      previewRecord?.iteration
                        ? [
                            previewRecord.iteration,
                            ...recentIterations.filter(
                              (it) => it._id !== previewRecord.iteration?._id,
                            ),
                          ]
                        : recentIterations
                    }
                    pendingRun={
                      previewRecord?.status === "running" &&
                      !previewRecord.iteration
                        ? {
                            model: previewRecord.model,
                            client: previewRecord.launchSnapshot?.namedHostId
                              ? (hostNamesById.get(
                                  previewRecord.launchSnapshot.namedHostId,
                                ) ?? undefined)
                              : undefined,
                          }
                        : undefined
                    }
                    onSelectLive={() => {
                      setReplayIteration(null);
                      setInspectIterationId(null);
                      setShowSpecOverride(false);
                    }}
                    selectedIterationId={
                      selectedTrialIteration(workspaceSelectedTrial)?._id ??
                      null
                    }
                    live={
                      workspacePaneView.kind === "recording" ||
                      workspaceLiveRecord?.status === "running"
                    }
                    onSelect={(it) => {
                      setReplayIteration(
                        previewRecord?.status === "running" &&
                          previewRecord.iteration?._id === it._id
                          ? null
                          : it,
                      );
                      setInspectIterationId(it._id);
                      setShowSpecOverride(false);
                      setMissingAppEvidenceStepId(null);
                    }}
                  >
                    {workspacePaneView.kind === "recording" ? (
                      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                        <span className="text-xs text-muted-foreground">
                          Click widgets to record
                        </span>
                        <CaptureModeToggle
                          mode={captureMode}
                          onChange={setCaptureMode}
                        />
                      </div>
                    ) : null}
                    {evidence}
                  </CaseRunTimeline>
                )}
                header={
                  workspacePaneView.kind === "recording" ? (
                    <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Click widgets to record ·
                      </span>
                      <CaptureModeToggle
                        mode={captureMode}
                        onChange={setCaptureMode}
                      />
                    </div>
                  ) : (
                    <TrialHeader
                      trial={workspaceSelectedTrial}
                      chain={
                        selectedTrialIteration(workspaceSelectedTrial)
                          ?.suiteRunId
                          ? trialChains.chains.get(
                              selectedTrialIteration(workspaceSelectedTrial)!
                                ._id,
                            )
                          : selectedTrialIteration(workspaceSelectedTrial)
                            ? chainForQuickRunIteration(
                                recentIterations.find(
                                  (it) =>
                                    it._id ===
                                    selectedTrialIteration(
                                      workspaceSelectedTrial,
                                    )?._id,
                                ) ??
                                  selectedTrialIteration(
                                    workspaceSelectedTrial,
                                  )!,
                              )
                            : null
                      }
                      run={workspaceTrialRun}
                      judgeCase={resolveIterationJudge(
                        selectedTrialIteration(workspaceSelectedTrial),
                        suiteRuns,
                      )}
                      iterations={recentIterations}
                      suiteRuns={suiteRuns}
                      hostNamesById={hostNamesById}
                      defaultHostLabel={suiteHostLabel}
                      hasHostAttachments={hasHostAttachments}
                      onSelectIteration={(it) => {
                        setReplayIteration(it);
                        setInspectIterationId(it._id);
                        setShowSpecOverride(false);
                        setMissingAppEvidenceStepId(null);
                      }}
                    />
                  )
                }
                evidence={
                  <>
                    {missingAppEvidenceStepId ? (
                      <div
                        className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground"
                        data-testid="case-workspace-no-app-evidence"
                      >
                        No app evidence was captured for this step
                      </div>
                    ) : null}
                    {workspacePaneView.kind === "recording" ? (
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
                    ) : workspaceLiveRecord ? (
                      <RunColumn
                        record={workspaceLiveRecord}
                        testCase={currentTestCase}
                        authoredSteps={editForm?.steps ?? currentSteps}
                        trialChainSlot={trialChainSlotFor(
                          workspaceLiveRecord.iteration ?? null,
                        )}
                        serverNames={connectedServerList}
                        projectId={projectId}
                        onContinueInChat={onContinueInChat}
                        onStreamingTraceLoaded={() =>
                          clearCompareStreamingState(
                            workspaceLiveRecord.modelValue,
                          )
                        }
                        activeTab={
                          runColumnTabByModel[workspaceLiveRecord.modelValue] ??
                          "scorecard"
                        }
                        onTabChange={(tab) =>
                          handleRunColumnTabChange(
                            workspaceLiveRecord.modelValue,
                            tab,
                          )
                        }
                        onRetry={() =>
                          void handleRunCompare({
                            modelValues: [workspaceLiveRecord.modelValue],
                            sessionMode: "reuse",
                          })
                        }
                        baselineHostStyle={hostConfigBaseline?.hostStyle}
                        syncedStepId={syncedStepId}
                        onSyncStep={setSyncedStepId}
                        scorecardSlot={
                          <TrialScorecard
                            authored={
                              authoredForTrial({
                                trial: workspaceSelectedTrial,
                                draft: workspaceDraftScorecardInput,
                                run: null,
                              }).authored
                            }
                            iteration={workspaceLiveRecord.iteration ?? null}
                            isRunning={workspaceLiveRecord.status === "running"}
                            judgeCase={resolveIterationJudge(
                              workspaceLiveRecord.iteration ?? null,
                              suiteRuns,
                            )}
                            steps={
                              workspaceLiveRecord.launchSnapshot?.steps ??
                              editForm?.steps ??
                              []
                            }
                            chain={
                              workspaceLiveRecord.iteration
                                ? chainForQuickRunIteration(
                                    workspaceLiveRecord.iteration,
                                  )
                                : null
                            }
                            liveStepStatusById={liveStepStatusById}
                            syncedStepId={syncedStepId}
                            onSyncStep={setSyncedStepId}
                          />
                        }
                      />
                    ) : workspacePersistedIteration ? (
                      <IterationDetails
                        iteration={workspacePersistedIteration}
                        requestedTab={trialTabRequest}
                        testCase={currentTestCase}
                        serverNames={effectiveSuiteServers}
                        layoutMode="full"
                        judgeCase={resolveIterationJudge(
                          workspacePersistedIteration,
                          suiteRuns,
                        )}
                        enableJudgeReview
                        trialChainSlot={trialChainSlotFor(
                          workspacePersistedIteration,
                        )}
                        syncedStepId={syncedStepId}
                        onSyncStep={setSyncedStepId}
                        trialVerdictWord={
                          workspaceSelectedTrial
                            ? trialVerdict(workspaceSelectedTrial).word
                            : undefined
                        }
                        scorecard={{
                          render: (ctx) => (
                            <TrialScorecard
                              authored={
                                authoredForTrial({
                                  trial: workspaceSelectedTrial,
                                  draft: workspaceDraftScorecardInput,
                                  run: workspaceTrialRun ?? null,
                                  forceSnapshot:
                                    workspaceLeftView.kind === "inspecting",
                                }).authored
                              }
                              iteration={workspacePersistedIteration}
                              steps={
                                workspacePersistedIteration.testCaseSnapshot
                                  ?.steps ??
                                editForm?.steps ??
                                []
                              }
                              chain={workspaceTrialChain}
                              judgeCase={resolveIterationJudge(
                                workspacePersistedIteration,
                                suiteRuns,
                              )}
                              nextQuestionSlot={nextQuestionForTrial(
                                workspacePersistedIteration,
                              )}
                              envelope={ctx.envelope}
                              judgeHidden={ctx.reviewActive && ctx.judgeHidden}
                              suggestionsSlot={
                                useSpine ? (
                                  <div ref={suggestionsRef}>
                                    <SuggestedFromRunSection
                                      enabled
                                      batch={suggestionBatch}
                                      authored={
                                        authoredForTrial({
                                          trial: workspaceSelectedTrial,
                                          draft: workspaceDraftScorecardInput,
                                          run: workspaceTrialRun ?? null,
                                        }).authored
                                      }
                                      judgeFor={(iteration) =>
                                        resolveIterationJudge(
                                          iteration,
                                          suiteRuns,
                                        )
                                      }
                                      selectedBlob={
                                        ctx.envelope
                                          ? {
                                              iterationId:
                                                workspacePersistedIteration._id,
                                              blob: ctx.envelope as never,
                                            }
                                          : null
                                      }
                                      prompts={(editForm?.steps ?? [])
                                        .filter(
                                          (step) => step.kind === "prompt",
                                        )
                                        .map((step) =>
                                          "prompt" in step ? step.prompt : "",
                                        )}
                                      dismissed={dismissedSuggestions}
                                      accepted={acceptedSuggestions}
                                      onAccept={(suggestion) =>
                                        acceptSuggestions([suggestion], "row")
                                      }
                                      onAcceptAll={(all) =>
                                        acceptSuggestions(all, "all")
                                      }
                                      onDismiss={dismissSuggestion}
                                    />
                                  </div>
                                ) : null
                              }
                              judgeSlot={
                                // The tab owns launch-triggered judging; this
                                // row owns presentation and the review control.
                                useSpine ? (
                                  <CaseJudgeAnswer
                                    run={workspaceTrialRun ?? null}
                                    iteration={workspacePersistedIteration}
                                    isQuickRun={
                                      !workspacePersistedIteration.suiteRunId
                                    }
                                    skippedForCase={
                                      editForm?.judgeConfigOverride
                                        ?.goalCompletion?.enabled === false
                                    }
                                    hidden={Boolean(
                                      ctx.reviewActive && ctx.judgeHidden,
                                    )}
                                  >
                                    {ctx.reviewActive &&
                                    resolveIterationJudge(
                                      workspacePersistedIteration,
                                      suiteRuns,
                                    ) ? (
                                      <TrialJudgeReviewPanel
                                        key={workspacePersistedIteration._id}
                                        iterationId={
                                          workspacePersistedIteration._id
                                        }
                                        judgeCase={resolveIterationJudge(
                                          workspacePersistedIteration,
                                          suiteRuns,
                                        )!}
                                        onVisibilityChange={
                                          ctx.onJudgeVisibilityChange
                                        }
                                      />
                                    ) : null}
                                  </CaseJudgeAnswer>
                                ) : ctx.reviewActive &&
                                  resolveIterationJudge(
                                    workspacePersistedIteration,
                                    suiteRuns,
                                  ) ? (
                                  // Keyed by trial: a switch remounts the
                                  // panel, so no read or label state from the
                                  // previous trial survives into this one.
                                  <TrialJudgeReviewPanel
                                    key={workspacePersistedIteration._id}
                                    iterationId={
                                      workspacePersistedIteration._id
                                    }
                                    judgeCase={resolveIterationJudge(
                                      workspacePersistedIteration,
                                      suiteRuns,
                                    )!}
                                    onVisibilityChange={
                                      ctx.onJudgeVisibilityChange
                                    }
                                  />
                                ) : resolveIterationJudge(
                                    workspacePersistedIteration,
                                    suiteRuns,
                                  ) ? (
                                  <JudgeVerdictPanel
                                    judgeCase={resolveIterationJudge(
                                      workspacePersistedIteration,
                                      suiteRuns,
                                    )!}
                                  />
                                ) : null
                              }
                              scoresSection={ctx.scoresSection}
                              syncedStepId={syncedStepId}
                              onSyncStep={setSyncedStepId}
                            />
                          ),
                        }}
                      />
                    ) : workspacePaneView.kind === "spec" &&
                      specPreviewTrace ? (
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
                        Start typing a prompt — the conversation will build
                        here.
                      </div>
                    )}
                  </>
                }
              />
            </>
          ) : (
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
                          protectPrompts
                          steps={editForm.steps}
                          onStepsChange={setSteps}
                          availableTools={assertableTools}
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

                    {!isDraft && currentTestCase._id ? (
                      <div className="pt-1">
                        <EvalAttachmentsEditor
                          suiteId={suiteId}
                          testCaseId={currentTestCase._id}
                          value={
                            (currentTestCase.attachments as
                              EvalAttachment[] | undefined) ?? []
                          }
                        />
                      </div>
                    ) : null}

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
                  latestAvailableIteration
                    ? latestRunNavCue.dotClass
                    : undefined
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
                        // A trial from a real suite run: labellable. The
                        // backend refuses a quick-run trial anyway
                        // (`JUDGE_REVIEW_NO_RUN`), and the panel renders that
                        // refusal rather than pretending.
                        enableJudgeReview
                        trialChainSlot={trialChainSlotFor(replayIteration)}
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
                          trialChainSlot={trialChainSlotFor(
                            previewRecord.iteration ?? null,
                          )}
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
                          enableJudgeReview
                          trialChainSlot={trialChainSlotFor(
                            latestTracedIteration,
                          )}
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
          )}
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
  trialChainSlot,
  scorecardSlot,
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
  trialChainSlot?: ReactNode;
  /**
   * The scorers for the attempt in flight, keyed to the snapshot it was
   * LAUNCHED with. A quick run stays in this column after it finishes
   * (`showRunInPreview`), so without this the most common trial on the page
   * would be the one with no scorecard.
   */
  scorecardSlot?: ReactNode;
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
      { hostConfigOverride?: { hostStyle?: string } } | undefined
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
      mergeStreamingTrace(
        record.streamingTrace,
        record.streamingDraftMessages,
        record.streamingLiveBrowserSteps,
      ),
    [
      record.streamingDraftMessages,
      record.streamingTrace,
      record.streamingLiveBrowserSteps,
    ],
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

  // Replay tab — the SHARED predicate, so this panel and the viewer's own gate
  // can't disagree. The persisted blob is authoritative once it loads; until then
  // the STREAMING envelope stands in, so a live run's first click opens the tab
  // instead of it staying hidden (and `effectiveActiveTab` bouncing "browser"
  // back to "timeline") until the blob arrives.
  const browserBlob = persistedTraceBlob as TraceEnvelope | null;
  const showBrowserTab = hasReplayArtifacts(
    browserBlob ?? streamingTraceEnvelope ?? {},
  );

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
  const runStepStatusById = useMemo<
    Map<string, EvalStepStatus> | undefined
  >(() => {
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
          : activeTab === "scorecard" && !scorecardSlot
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
  const showScorecard = effectiveActiveTab === "scorecard" && scorecardSlot;
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
  const shellStyle = getScenarioShellStyle(hostStyle, themeMode);

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
            effectiveActiveTab === "steps" ||
            effectiveActiveTab === "scorecard"
              ? "timeline"
              : effectiveActiveTab
          }
          onModeChange={onTabChange}
          showTraceTabs
          showComparisonChrome={false}
          compactCompareHeader={false}
          result={runColumnResult}
          hideStatus={Boolean(scorecardSlot)}
          showToolsTab={showToolsTab}
          showScorecardTab={Boolean(scorecardSlot)}
          scorecardActive={effectiveActiveTab === "scorecard"}
          onSelectScorecard={() => onTabChange("scorecard")}
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
        {trialChainSlot}
        {showScorecard ? (
          <div className="min-h-0 flex-1 overflow-y-auto">{scorecardSlot}</div>
        ) : shouldRenderChatShell ? (
          <ScenarioHostStyleProvider value={hostStyle}>
            <ScenarioHostThemeProvider value={themeMode}>
              <div
                className={cn(
                  "scenario-host-shell app-theme-scope flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50",
                  themeMode === "dark" && "dark",
                )}
                data-host-style={hostStyle}
                style={shellStyle}
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
                  {renderedRunContent}
                </div>
              </div>
            </ScenarioHostThemeProvider>
          </ScenarioHostStyleProvider>
        ) : (
          renderedRunContent
        )}
      </div>
    </div>
  );
}
