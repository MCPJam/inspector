/**
 * browser-session-context.ts — per-session browser-rendered MCP App context for
 * any runner that mocks a user session (eval iterations, synthetic chatbox
 * sessions).
 *
 * Grown out of the eval-only `browser-eval-context.ts` (PR 14): the harness
 * wiring is surface-neutral, so the same context now serves every consumer
 * through two attachment styles:
 *
 *   Engine paths (`runAssistantTurn` → `runChatEngineLoop`):
 *   - `computerWidgetTools` — wire-format `computer` + `finish_widget` tools
 *     (regular function tools; the provider-native factory's lazy schema
 *     serializes to an empty object on the Convex `/stream` wire). Merged into
 *     the tool map the runner passes to `runAssistantTurn`, executed locally by
 *     `executeToolCallsFromMessages`, with screenshots reaching the model as
 *     image content via the tool's `toModelOutput` (honored by the shared
 *     executor since PR 14).
 *   - `prepareAdvertisedTools` — hides both tools until a widget is actually
 *     mounted in the harness (the engine additionally enforces execution
 *     against the advertised subset).
 *   - `handleEngineToolResult` — the engine's `onToolResult` hook (awaited by
 *     `emitToolResults` since PR 14, so a rendered widget is mounted before the
 *     next step's gate runs). Renders MCP App tool results in the harness and
 *     records `RunnerWidgetRenderObservation`s.
 *   - `noteToolCallInput` — the engine's `onToolCall` hook; caches tool-call
 *     inputs so the render hook can feed the OpenAI-compat shim the same
 *     `toolInput` the live widget would have received.
 *
 *   Local AI-SDK paths (`runDirectChatTurn`):
 *   - `handleDirectToolResultChunk` — the `traceEvents.onToolResultChunk`
 *     hook (awaited by the helper). The chunk already carries the normalized
 *     tool input, so no input cache is involved.
 *   - The same `computerWidgetTools` / `prepareAdvertisedTools` attach to the
 *     helper's tool map and prepareStep gate. Note the tools stay wire-format
 *     here too: the local consumers (eval local-BYOK, simulation local org
 *     BYOK) share finalize/persistence paths with hosted runs, and the
 *     function-tool surface works on every provider.
 *
 * One context per session/iteration; `dispose()` MUST run (callers wrap the
 * body in try/finally) so a launched Chromium never outlives its session.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolSet } from "ai";
import {
  DEFAULT_VIEWPORT,
  McpAppBrowserHarness,
  type WidgetToolCall,
} from "../utils/mcp-app-browser-harness";
import {
  MAX_SCRIPTED_STEP_TEXT_CHARS,
  type ElementLocator,
  type ScriptedStep,
  type ScriptedWidgetCheck,
  type StepAssertion,
} from "@/shared/scripted-steps";
import type { InteractAction, WidgetAssertion } from "@/shared/steps";
import {
  buildComputerUseTools,
  resolveComputerUseToolVersion,
} from "../utils/computer-use-tool";
import { modelSupportsComputerUse } from "../utils/model-capabilities";
import {
  isRenderableMcpAppTool,
  renderMcpAppToolResult,
} from "../utils/mcp-app-render-observation";
import type { MCPJamToolResultEvent } from "../utils/mcpjam-stream-handler.js";
import type { DirectChatTurnToolResultChunk } from "../utils/direct-chat-turn.js";
import type { PrepareAdvertisedTools } from "../utils/advertised-tools";
import {
  isEvalTraceBrowserStepNote,
  type EvalTraceBrowserAction,
  type RunnerBrowserInteractionStep,
  type RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../utils/logger";

/**
 * Extract the SEP-1865 `_meta.ui.visibility` array from a tool's metadata entry
 * (as returned by `MCPClientManager.getAllToolsMetadata(serverId)[name]`).
 * Returns the typed array when present and well-formed, else `undefined` —
 * which downstream is treated as the spec default `["model", "app"]`
 * (model-visible). Kept narrow and pure; the app-only routing decision reuses
 * the SDK's `isAppOnlyTool` predicate rather than re-deriving the rule here.
 */
function resolveToolVisibilityFromMeta(
  meta: Record<string, unknown> | undefined
): Array<"model" | "app"> | undefined {
  const visibility = (meta as { ui?: { visibility?: unknown } } | undefined)?.ui
    ?.visibility;
  if (!Array.isArray(visibility)) return undefined;
  const vals = visibility.filter(
    (v): v is "model" | "app" => v === "model" || v === "app"
  );
  return vals.length ? vals : undefined;
}

/** Cap on the number of `ui/message` follow-ups recorded as a per-step artifact
 *  (the *driven* count is bounded separately by `MAX_WIDGET_FOLLOWUP_TURNS`). */
const MAX_FOLLOWUP_ARTIFACTS_PER_STEP = 10;

/**
 * Bound widget `ui/message` follow-up text before it becomes a durable trace
 * artifact: cap the count per step and truncate each string. Keeps a misbehaving
 * widget (one that spams long messages) from bloating the persisted trace. The
 * per-string cap reuses the harness's scripted-text limit.
 */
/** Truncate one follow-up message to the scripted-text limit. Shared by the
 *  artifact bound and the model-driving drain so a single oversized `ui/message`
 *  can neither bloat the persisted trace nor the next LLM request. */
function truncateFollowUpText(text: string): string {
  return text.length > MAX_SCRIPTED_STEP_TEXT_CHARS
    ? text.slice(0, MAX_SCRIPTED_STEP_TEXT_CHARS)
    : text;
}

export function boundFollowUpsForArtifact(
  followUps: readonly string[],
): string[] {
  return followUps
    .slice(0, MAX_FOLLOWUP_ARTIFACTS_PER_STEP)
    .map(truncateFollowUpText);
}

/** Map a scripted step to the closest Computer Use action verb so it shares the
 *  existing `browserInteractionStep.action` enum (no closed-union change). An
 *  `assert` step has no verb — it captures/inspects state, so → `"screenshot"`,
 *  disambiguated by the `assertion` field on the recorded step. */
function scriptedKindToAction(step: ScriptedStep): EvalTraceBrowserAction {
  switch (step.kind) {
    case "click":
      return step.clickType === "double"
        ? "double_click"
        : step.clickType === "right"
        ? "right_click"
        : "left_click";
    case "type":
      return "type";
    case "key":
      return "key";
    case "scroll":
      return "scroll";
    case "wait":
      return "wait";
    case "assert":
      return "screenshot";
  }
}

/** Human-readable target label for the replay timeline. */
function describeLocator(t: ElementLocator): string {
  if (t.testId) return `testId=${t.testId}`;
  if (t.role)
    return `role=${t.role.role}${t.role.name ? `[name="${t.role.name}"]` : ""}`;
  if (t.text) return `text="${t.text}"`;
  if (t.css) return `css=${t.css}`;
  return "";
}

function describeScriptedStep(step: ScriptedStep): string | undefined {
  if (step.kind === "click" || step.kind === "type")
    return describeLocator(step.target);
  if (step.kind === "key") return `key=${step.key}`;
  if (step.kind === "assert") {
    const a = step.assertion;
    if (a.type === "textVisible") return `text="${a.text}"`;
    if (a.type === "widgetToolCalled") return `tool=${a.toolName}`;
    return describeLocator(a.target);
  }
  return undefined;
}

/**
 * Map a unified-model `InteractAction` onto the legacy `ScriptedStep` the
 * harness already knows how to replay. The two vocabularies are intentionally
 * isomorphic for the action kinds (click/type/key/scroll/wait) — see
 * `shared/steps.ts`. The `assert` `ScriptedStep` kind has no `InteractAction`
 * counterpart (assertions are first-class `assert` steps, never inside
 * `interact`), so this never produces one.
 */
export function interactActionToScriptedStep(
  action: InteractAction
): ScriptedStep {
  switch (action.kind) {
    case "click":
      return {
        kind: "click",
        target: action.target,
        ...(action.clickType ? { clickType: action.clickType } : {}),
      };
    case "type":
      return { kind: "type", target: action.target, text: action.text };
    case "key":
      return { kind: "key", key: action.key };
    case "scroll":
      return {
        kind: "scroll",
        direction: action.direction,
        ...(action.amount ? { amount: action.amount } : {}),
      };
    case "wait":
      return { kind: "wait", ms: action.ms };
  }
}

/**
 * Map a unified-model `WidgetAssertion` onto the legacy `StepAssertion` the
 * harness evaluates against the live widget DOM. `widgetRendered` is NOT a
 * `WidgetAssertion` (it is a transcript `Predicate`), so it never reaches here.
 */
export function widgetAssertionToStepAssertion(
  assertion: WidgetAssertion
): StepAssertion {
  switch (assertion.kind) {
    case "textVisible":
      return { type: "textVisible", text: assertion.text };
    case "elementVisible":
      return { type: "elementVisible", target: assertion.target };
    case "elementHidden":
      return { type: "elementHidden", target: assertion.target };
    case "inputValue":
      return {
        type: "inputValue",
        target: assertion.target,
        equals: assertion.equals,
      };
    case "widgetToolCalled":
      return { type: "widgetToolCalled", toolName: assertion.calledToolName };
  }
}

/** Outcome of replaying one unified-model `interact`/widget `assert` step. */
export interface WidgetStepOutcome {
  ok: boolean;
  reason?: string;
  /**
   * Widget→host tool calls the action triggered (e.g. a click that made the
   * widget invoke an MCP tool). The unified executor folds these into the
   * iteration transcript so a "tool was called" check sees widget-initiated
   * calls. Absent/empty ⇒ the action invoked no host tools.
   */
  widgetToolCalls?: WidgetToolCall[];
}

export interface CreateBrowserSessionContextParams {
  /** Driver model id for model-driven turns (text + MCP tool calls + widget
   *  render). Omitted for model-free sessions (a pinned-tool-call / render-check
   *  iteration). NOTE: this no longer governs Computer Use — see
   *  `enableComputerUse`. The harness renders widgets and records observations
   *  regardless of the driver. */
  model?: string;
  /** Opt IN to Computer Use (the model-facing `computer` + `finish_widget`
   *  tools that let the driver drive a rendered widget by screenshots).
   *  **Default OFF.** Computer Use is non-deterministic/agentic and is reserved
   *  for session simulation; evals are deterministic and never opt in (they use
   *  `Interact` steps for widget interaction). When true AND `model` supports it
   *  (mapped Claude ids resolve offline; others need vision + tool calling per
   *  model-capabilities.ts), the computer tools are advertised. */
  enableComputerUse?: boolean;
  mcpClientManager: MCPClientManager;
  injectOpenAiCompat?: boolean;
  /** Log prefix so each surface stays greppable. Defaults to `"evals"`. */
  logScope?: "evals" | "sessionSimulation";
  /** Iteration-level render budget (ms). Applied to the harness when first
   *  launched; used by pinned-tool-call turns that carry a `renderTimeoutMs`
   *  override. Harness default applies when absent. */
  renderTimeoutMs?: number;
}

export interface BrowserSessionContext {
  /** Whether the driver model gets the `computer` / `finish_widget` tools. */
  readonly computerUseSupported: boolean;
  /** Anthropic provider-native version for mapped Claude ids, else null.
   *  Null does NOT mean Computer Use is off — see `computerUseSupported`. */
  readonly computerUseVersion: ReturnType<typeof resolveComputerUseToolVersion>;
  /** Wire-format `computer` + `finish_widget`, or `{}` when the driver model
   *  lacks vision/tool-calling. */
  readonly computerWidgetTools: ToolSet;
  /** Collected render observations (promptIndex stamped at push time). */
  readonly widgetRenderObservations: RunnerWidgetRenderObservation[];
  /** Collected Computer Use steps (promptIndex/stepIndex stamped at push time). */
  readonly browserInteractionSteps: RunnerBrowserInteractionStep[];
  /** Advertised-tool gate: hide computer tools until a widget is mounted. */
  readonly prepareAdvertisedTools: PrepareAdvertisedTools | undefined;
  /** Failed widget interaction checks (a failed assertion, or a group whose
   *  widget never rendered). Non-empty ⇒ the runner fails the iteration. */
  readonly scriptedCheckFailures: { toolName: string; reason: string }[];
  /**
   * Take and clear the `ui/message` follow-ups captured since the last drain.
   * The runner replays each as a new user turn after the current prompt's turn
   * (and its widget interactions) complete — the run-side analogue of chat's
   * `onSendFollowUp -> sendMessage`.
   */
  drainFollowUps(): string[];
  /** Runner loop bookkeeping: stamp artifacts with the active prompt turn. */
  setActivePromptIndex(promptIndex: number): void;
  /**
   * Stamp subsequently-recorded artifacts (render observations + interaction
   * steps) with the authored `TestStep.id` currently executing, so the replay
   * Steps view can bucket each artifact under its authored step. Pass `null`
   * when no authored step is active (Computer Use / session-simulation paths)
   * so those artifacts stay legacy-shaped. Mirrors `setActivePromptIndex`.
   */
  setActiveAuthoredStepId(stepId: string | null): void;
  /**
   * Set the current turn's per-widget check groups. The render hooks replay a
   * group's steps the moment its widget mounts (model OR pinned). Flushes the
   * previous turn's groups first — any group whose widget never rendered is
   * recorded as a failure (fail-closed: you asserted on a widget that didn't
   * appear).
   */
  setActiveWidgetChecks(checks: ScriptedWidgetCheck[]): void;
  /** Flush the active turn's groups (record unrun groups as failures). Call
   *  after the last turn so a trailing turn's unrun checks still fail closed. */
  flushActiveWidgetChecks(): void;
  /** Engine `onToolCall` hook — caches inputs for the render hook. */
  noteToolCallInput(event: { toolCallId: string; input: unknown }): void;
  /** Engine `onToolResult` hook — renders MCP App results in the harness. */
  handleEngineToolResult(event: MCPJamToolResultEvent): Promise<void>;
  /** Local AI-SDK `traceEvents.onToolResultChunk` hook — same render path,
   *  with the tool input taken from the chunk instead of the call cache. */
  handleDirectToolResultChunk(
    chunk: Pick<
      DirectChatTurnToolResultChunk,
      "toolCallId" | "toolName" | "input" | "output" | "serverId"
    >
  ): Promise<void>;
  /**
   * Model-free pinned-tool-call render path. Same render+observe pipeline as
   * the model hooks, but a tool with no UI resource records an explicit
   * `no_ui_resource` observation (so a render check fails closed) instead of
   * being silently skipped. Like the model hooks, it also replays any active
   * widget-check group matching the rendered tool.
   */
  renderPinnedToolResult(args: {
    toolCallId: string;
    toolName: string;
    serverId: string;
    toolInput: Record<string, unknown> | undefined;
    output: unknown;
  }): Promise<void>;
  /**
   * The tool that rendered the currently-mounted widget, or `null` when no
   * widget is live. The unified step executor reads this to target an
   * `interact`/widget-`assert` step at "the most-recent widget for `toolName`"
   * and to fail closed when nothing is mounted or the live widget belongs to a
   * different tool. The harness keeps at most one widget mounted, so this is
   * unambiguous by construction.
   */
  readonly mountedWidgetToolName: string | null;
  /**
   * Replay one unified-model `interact` action against the currently-mounted
   * widget for `toolName`. FAILS CLOSED (`ok: false`) when no widget is mounted
   * or the live widget was rendered by a different tool — the executor records
   * a fail-closed interaction failure that fails the iteration. Records a
   * `browserInteractionStep` exactly like a scripted check step.
   */
  replayInteractStep(
    toolName: string,
    action: InteractAction
  ): Promise<WidgetStepOutcome>;
  /**
   * Evaluate one unified-model widget `assert` (DOM-level `WidgetAssertion`)
   * against the currently-mounted widget for `toolName`. FAILS CLOSED when no
   * matching widget is mounted. Records a `browserInteractionStep` carrying the
   * assertion verdict.
   */
  evaluateWidgetAssertion(
    toolName: string,
    assertion: WidgetAssertion
  ): Promise<WidgetStepOutcome>;
  /**
   * Tell the session to KEEP rendered widgets mounted so the unified step
   * executor can drive a later `interact`/`assert` step against them. The
   * executor calls this once with `true` when the case carries any such step.
   */
  setKeepWidgetsMountedForSteps(keep: boolean): void;
  /**
   * Return artifacts appended since the previous drain (both arrays stay
   * intact for end-of-run consumers like `finalizeEvalIteration`). Lets
   * per-turn persisters (the simulation runner) upload incrementally.
   */
  drainNewArtifacts(): {
    observations: RunnerWidgetRenderObservation[];
    steps: RunnerBrowserInteractionStep[];
  };
  /** Start-of-turn hygiene: a widget kept mounted by a previous prompt turn
   *  must not bleed into this one. */
  dismissCarriedWidget(): Promise<void>;
  /**
   * Terminal-artifact hook: finalize and read the iteration's replay `.webm`,
   * or `null` when no browser ran / recording failed. Idempotent + fail-soft
   * (never throws); closes the harness context to flush the video, so a later
   * `dispose()` is a no-op for that part. Call once, just before `dispose()`,
   * from the shared finalize step.
   */
  collectVideo(): Promise<Buffer | null>;
  /** Tear down the harness (and Chromium, if launched). Always call. */
  dispose(): Promise<void>;
}

export async function createBrowserSessionContext(
  params: CreateBrowserSessionContextParams
): Promise<BrowserSessionContext> {
  const { mcpClientManager, injectOpenAiCompat } = params;
  const scope = params.logScope ?? "evals";
  // Computer Use is OPT-IN (default off) and reserved for session simulation;
  // evals never opt in (they interact deterministically via Interact steps). No
  // opt-in OR no driver model ⇒ no Computer Use; skip the capability probe. The
  // harness still renders widgets and records observations either way.
  const computerUseVersion =
    params.enableComputerUse === true && params.model
      ? resolveComputerUseToolVersion(params.model)
      : null;
  // Capability gate, resolved ONCE at construction so the tool surface is
  // deterministic for the whole session/iteration: mapped Claude ids are
  // eligible offline; anything else needs vision + tool calling per the
  // OpenRouter catalog. Unknown/unreachable → no computer tools (the
  // pre-feature behavior for non-Claude drivers).
  const computerUseSupported =
    params.enableComputerUse === true &&
    params.model != null &&
    (computerUseVersion !== null ||
      (await modelSupportsComputerUse(params.model)));

  const widgetHarnessRef: { current: McpAppBrowserHarness | null } = {
    current: null,
  };
  const widgetRenderObservations: RunnerWidgetRenderObservation[] = [];
  const browserInteractionSteps: RunnerBrowserInteractionStep[] = [];
  // `ui/message` follow-ups emitted by widgets during scripted replay, in
  // capture order. Drained by the runner, which replays each as a new model
  // turn (the run-side analogue of chat's `onSendFollowUp -> sendMessage`).
  const capturedFollowUps: string[] = [];
  const stepIndexByToolCallId = new Map<string, number>();
  // Per-widget accumulator of widget→host tool calls, so a `widgetToolCalled`
  // assert in a LATER unified step sees calls an earlier `interact` step
  // triggered. `runWidgetCheckGroup` keeps this as a group-local `accumulated`;
  // the unified executor replays steps independently, so it persists here.
  const priorWidgetCallsByToolCallId = new Map<string, WidgetToolCall[]>();
  const inputByToolCallId = new Map<string, Record<string, unknown>>();
  let activePromptIndex = 0;
  // Authored `TestStep.id` of the step currently executing (unified step
  // executor stamps this); null on Computer Use / session-simulation paths.
  let activeAuthoredStepId: string | null = null;
  let drainedObservationCount = 0;
  let drainedStepCount = 0;
  // Per-widget interaction checks for the active turn + whether each ran. The
  // render hooks replay a group when its widget mounts; unrun groups flush to
  // `scriptedCheckFailures` (fail-closed). Accumulated across the iteration.
  let activeWidgetChecks: { group: ScriptedWidgetCheck; ran: boolean }[] = [];
  const scriptedCheckFailures: { toolName: string; reason: string }[] = [];
  // The tool + toolCallId that rendered the currently-mounted widget, or null.
  // Updated when a renderable widget mounts (kept mounted), cleared when the
  // carried widget is dismissed. The unified step executor reads this to target
  // `interact` / widget-`assert` steps and to fail closed on a missing or
  // mismatched widget. The harness keeps at most one widget mounted, so a
  // single { toolCallId, toolName } is sufficient (no ambiguity by construction).
  let mountedWidget: { toolCallId: string; toolName: string } | null = null;
  // The unified step executor sets this when the case contains `interact` /
  // widget-`assert` steps so a rendered widget is KEPT mounted (independent of
  // Computer Use / legacy widget-check groups) and a later step can drive it.
  let keepWidgetsMountedForSteps = false;

  const flushActiveWidgetChecks = (): void => {
    for (const entry of activeWidgetChecks) {
      if (!entry.ran) {
        scriptedCheckFailures.push({
          toolName: entry.group.toolName,
          reason: `no widget rendered for tool "${entry.group.toolName}"`,
        });
      }
    }
    activeWidgetChecks = [];
  };

  const ensureWidgetHarness = (): McpAppBrowserHarness => {
    if (!widgetHarnessRef.current) {
      widgetHarnessRef.current = new McpAppBrowserHarness({
        callTool: (sid, name, args) =>
          mcpClientManager.executeTool(sid, name, args),
        resolveToolVisibility: (sid, name) =>
          resolveToolVisibilityFromMeta(
            mcpClientManager.getAllToolsMetadata(sid)?.[name]
          ),
        viewport: DEFAULT_VIEWPORT,
        // Honor a pinned turn's per-render budget override (mirrors the legacy
        // probe harness construction). Harness default applies when absent.
        ...(params.renderTimeoutMs
          ? { budgets: { renderTimeoutMs: params.renderTimeoutMs } }
          : {}),
      });
    }
    return widgetHarnessRef.current;
  };
  // Map an artifact `ts` to its offset (ms) into the replay video, using the
  // harness's recording-start origin. `undefined` when no recording is active
  // (no Chromium / no video dir) so the field stays absent for legacy runs.
  const videoOffsetFor = (ts: number): number | undefined => {
    const start = widgetHarnessRef.current?.getRecordingStartedAt?.() ?? null;
    return start != null ? Math.max(0, ts - start) : undefined;
  };
  // Eager (cheap) construction when Computer Use is supported so the computer
  // tools can reference the harness; Chromium still launches lazily on the
  // first widget render.
  if (computerUseSupported) ensureWidgetHarness();

  const computerWidgetTools: ToolSet = computerUseSupported
    ? buildComputerUseTools({
        // Version only matters for the provider-native form; wire format is
        // version-independent, so non-Claude drivers simply omit it.
        ...(computerUseVersion ? { version: computerUseVersion } : {}),
        harness: ensureWidgetHarness(),
        // The harness keeps at most one widget mounted — it is the single
        // source of truth for the active widget across turns and dismissals.
        getActiveToolCallId: () =>
          widgetHarnessRef.current?.getMountedWidgetId() ?? null,
        viewport: DEFAULT_VIEWPORT,
        // Hosted paths serialize tool defs to flat JSON for the Convex
        // `/stream` request; the provider-native factory can't ride that wire.
        wireFormat: true,
        // One browserInteractionStep per executeAction. The screenshot stays
        // base64 here; the persisters upload it (finalizeEvalIteration for
        // evals, the per-turn artifact write for synthetic sessions).
        onAction: (result, { toolCallId }) => {
          const stepIndex = (stepIndexByToolCallId.get(toolCallId) ?? -1) + 1;
          stepIndexByToolCallId.set(toolCallId, stepIndex);
          // The harness types `note` as an open string; the backend union is
          // closed and rejects the whole turn on an unknown literal. Narrow
          // through the guard — keep the step, drop an unrecognized note.
          let note: RunnerBrowserInteractionStep["note"];
          if (result.note !== undefined) {
            if (isEvalTraceBrowserStepNote(result.note)) {
              note = result.note;
            } else {
              logger.warn(`[${scope}] dropping unknown browser-step note`, {
                note: result.note,
                toolCallId,
              });
            }
          }
          browserInteractionSteps.push({
            toolCallId,
            stepIndex,
            promptIndex: activePromptIndex,
            ...(activeAuthoredStepId
              ? { authoredStepId: activeAuthoredStepId }
              : {}),
            action: result.action.action,
            coordinateX: result.action.coordinate?.[0],
            coordinateY: result.action.coordinate?.[1],
            text: result.action.text,
            scrollDirection: result.action.scrollDirection,
            scrollAmount: result.action.scrollAmount,
            duration: result.action.duration,
            screenshotBase64: result.screenshotBase64,
            widgetToolCalls: result.widgetToolCalls,
            elapsedMs: result.elapsedMs,
            ...(note ? { note } : {}),
            ts: Date.now(),
          });
        },
      })
    : {};

  // Gate Computer Use tools on the harness's live mount — the SAME source
  // `getActiveToolCallId` reads — so the model only sees `computer` /
  // `finish_widget` when an action can actually target a widget.
  const prepareAdvertisedTools: PrepareAdvertisedTools | undefined =
    computerUseSupported
      ? ({ defaultToolNames }) =>
          widgetHarnessRef.current?.getMountedWidgetId()
            ? defaultToolNames
            : defaultToolNames.filter(
                (n) => n !== "computer" && n !== "finish_widget"
              )
      : undefined;

  /**
   * Replay one widget-check group against the just-mounted widget. Pushes a
   * `browserInteractionStep` per step (source: "scripted"), accumulates
   * widget→host tool calls so a `widgetToolCalled` assertion sees earlier
   * steps' calls, stops at the first failure, and records a failure into
   * `scriptedCheckFailures` (the runner's verdict gate reads it).
   */
  const runWidgetCheckGroup = async (
    toolCallId: string,
    toolName: string,
    steps: ScriptedStep[]
  ): Promise<void> => {
    const harness = widgetHarnessRef.current;
    if (!harness) return;
    const accumulated: WidgetToolCall[] = [];
    for (const step of steps) {
      const res = await harness.runScriptedStep({
        toolCallId,
        step,
        priorWidgetToolCalls: accumulated,
      });
      if (res.widgetToolCalls.length) accumulated.push(...res.widgetToolCalls);
      if (res.followUps?.length) capturedFollowUps.push(...res.followUps);
      const stepIndex = (stepIndexByToolCallId.get(toolCallId) ?? -1) + 1;
      stepIndexByToolCallId.set(toolCallId, stepIndex);
      let note: RunnerBrowserInteractionStep["note"];
      if (res.note !== undefined && isEvalTraceBrowserStepNote(res.note)) {
        note = res.note;
      }
      const locatorLabel = describeScriptedStep(step);
      browserInteractionSteps.push({
        toolCallId,
        stepIndex,
        promptIndex: activePromptIndex,
        ...(activeAuthoredStepId
          ? { authoredStepId: activeAuthoredStepId }
          : {}),
        action: scriptedKindToAction(step),
        source: "scripted",
        ...(locatorLabel ? { locatorLabel } : {}),
        ...(step.kind === "type" ? { text: step.text } : {}),
        ...(step.kind === "assert"
          ? {
              assertion: {
                type: step.assertion.type,
                passed: res.ok,
                ...(res.reason ? { reason: res.reason } : {}),
              },
            }
          : {}),
        ok: res.ok,
        screenshotBase64: res.screenshotBase64,
        widgetToolCalls: res.widgetToolCalls,
        ...(res.followUps?.length
          ? { followUps: boundFollowUpsForArtifact(res.followUps) }
          : {}),
        elapsedMs: res.elapsedMs,
        ...(note ? { note } : {}),
        ts: Date.now(),
      });
      // Stop at the first failure: later steps usually depend on it, so
      // cascading failures add noise. The first reason is the actionable one.
      if (!res.ok) {
        scriptedCheckFailures.push({
          toolName,
          reason: res.reason ?? `scripted step "${step.kind}" failed`,
        });
        return;
      }
    }
  };

  /**
   * Replay ONE step (a unified-model `interact` action or widget `assert`)
   * against the live widget and return its outcome. Records a single
   * `browserInteractionStep` (source: "scripted") exactly like
   * `runWidgetCheckGroup` does per step, so the replay timeline / Browser tab
   * stays uniform. Unlike `runWidgetCheckGroup`, the verdict is RETURNED (not
   * pushed onto `scriptedCheckFailures`) — the unified executor owns the
   * per-step assertion record and the iteration verdict.
   */
  const replayWidgetScriptedStep = async (
    toolCallId: string,
    step: ScriptedStep
  ): Promise<WidgetStepOutcome> => {
    const harness = widgetHarnessRef.current;
    if (!harness) {
      return { ok: false, reason: "no rendered widget" };
    }
    const priorWidgetToolCalls =
      priorWidgetCallsByToolCallId.get(toolCallId) ?? [];
    const res = await harness.runScriptedStep({
      toolCallId,
      step,
      priorWidgetToolCalls,
    });
    if (res.widgetToolCalls.length) {
      priorWidgetCallsByToolCallId.set(toolCallId, [
        ...priorWidgetToolCalls,
        ...res.widgetToolCalls,
      ]);
    }
    if (res.followUps.length) capturedFollowUps.push(...res.followUps);
    const stepIndex = (stepIndexByToolCallId.get(toolCallId) ?? -1) + 1;
    stepIndexByToolCallId.set(toolCallId, stepIndex);
    let note: RunnerBrowserInteractionStep["note"];
    if (res.note !== undefined && isEvalTraceBrowserStepNote(res.note)) {
      note = res.note;
    }
    const locatorLabel = describeScriptedStep(step);
    const ts = Date.now();
    const videoOffsetMs = videoOffsetFor(ts);
    browserInteractionSteps.push({
      toolCallId,
      stepIndex,
      promptIndex: activePromptIndex,
      ...(activeAuthoredStepId ? { authoredStepId: activeAuthoredStepId } : {}),
      ...(videoOffsetMs !== undefined ? { videoOffsetMs } : {}),
      action: scriptedKindToAction(step),
      source: "scripted",
      ...(locatorLabel ? { locatorLabel } : {}),
      ...(step.kind === "type" ? { text: step.text } : {}),
      ...(step.kind === "assert"
        ? {
            assertion: {
              type: step.assertion.type,
              passed: res.ok,
              ...(res.reason ? { reason: res.reason } : {}),
            },
          }
        : {}),
      ok: res.ok,
      screenshotBase64: res.screenshotBase64,
      widgetToolCalls: res.widgetToolCalls,
      ...(res.followUps?.length
        ? { followUps: boundFollowUpsForArtifact(res.followUps) }
        : {}),
      elapsedMs: res.elapsedMs,
      ...(note ? { note } : {}),
      ts,
    });
    return {
      ok: res.ok,
      ...(res.reason ? { reason: res.reason } : {}),
      ...(res.widgetToolCalls.length
        ? { widgetToolCalls: res.widgetToolCalls }
        : {}),
    };
  };

  /** Shared render path: read the widget resource, mount it in the harness,
   *  record the observation, then replay any matching widget-check group while
   *  the widget is mounted. Containment contract: never throws.
   *
   *  `recordNonRenderable` flips the behavior for a tool that declares no UI
   *  resource: the model path silently skips it (a model calling a non-UI tool
   *  shouldn't manufacture a render observation), but a pinned render check
   *  MUST record an explicit `no_ui_resource` observation so `widgetRendered`
   *  fails closed with a clear status instead of an empty scope. */
  const renderIfRenderable = async (args: {
    toolCallId: string;
    toolName: string;
    serverId: string;
    toolInput: Record<string, unknown> | undefined;
    output: unknown;
    recordNonRenderable?: boolean;
  }): Promise<void> => {
    const meta = mcpClientManager.getAllToolsMetadata(args.serverId)?.[
      args.toolName
    ];
    // A widget-check group targeting this tool: run it after the render, and
    // keep the widget mounted (independent of Computer Use) so the steps can
    // drive it. Marks the group as run for unrun-group fail-closed tracking.
    const checkEntry = activeWidgetChecks.find(
      (e) => e.group.toolName === args.toolName
    );
    if (!isRenderableMcpAppTool(meta)) {
      if (args.recordNonRenderable) {
        widgetRenderObservations.push({
          toolCallId: args.toolCallId,
          toolName: args.toolName,
          serverId: args.serverId,
          status: "no_ui_resource",
          elapsedMs: 0,
          ts: Date.now(),
          promptIndex: activePromptIndex,
          ...(activeAuthoredStepId
            ? { authoredStepId: activeAuthoredStepId }
            : {}),
        });
      }
      return;
    }
    try {
      const obs = await renderMcpAppToolResult({
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        serverId: args.serverId,
        toolMetadata: meta,
        toolInput: args.toolInput,
        output: args.output,
        mcpClientManager,
        injectOpenAiCompat,
        harness: ensureWidgetHarness(),
        // Retain when the driver model can drive it (Computer Use), when a
        // widget-check group needs to run against it, OR when the unified step
        // executor has pending `interact`/`assert` steps for this case.
        keepMounted:
          computerUseSupported || !!checkEntry || keepWidgetsMountedForSteps,
      });
      // Stamp promptIndex at push-time — the harness type stays pure; the
      // runner loop is the single source of truth for promptIndex. Split off
      // render-time follow-ups so the trace observation stays a pure render
      // record; they drive model turns via `capturedFollowUps` below.
      const { followUps: renderFollowUps, ...renderObs } = obs;
      widgetRenderObservations.push({
        ...renderObs,
        promptIndex: activePromptIndex,
        ...(activeAuthoredStepId
          ? { authoredStepId: activeAuthoredStepId }
          : {}),
      });
      // Auto-send-on-render: a `ui/message` the widget emitted during its
      // initial render is an intended model-continuation turn. The step
      // executor drains these after the prompt/toolCall step.
      if (renderFollowUps?.length) {
        capturedFollowUps.push(...renderFollowUps);
      }
      // Track the live widget for unified `interact`/`assert` targeting. Only a
      // successfully-rendered, kept-mounted widget is drivable; otherwise leave
      // `mountedWidget` so a later interact/assert fails closed.
      if (
        obs.status === "rendered" &&
        (computerUseSupported || !!checkEntry || keepWidgetsMountedForSteps)
      ) {
        mountedWidget = {
          toolCallId: args.toolCallId,
          toolName: args.toolName,
        };
      }
      logger.debug(`[${scope}] widget render observation`, {
        toolName: args.toolName,
        status: obs.status,
      });
      if (checkEntry) {
        if (checkEntry.ran) {
          // v1 invariant: a tool renders at most one widget per turn. A second
          // matching render can't be targeted by the toolName key, so fail
          // closed rather than silently re-run against the first render.
          scriptedCheckFailures.push({
            toolName: args.toolName,
            reason: `multiple widgets for tool "${args.toolName}" in one turn are not supported yet`,
          });
        } else {
          checkEntry.ran = true;
          if (obs.status === "rendered") {
            await runWidgetCheckGroup(
              args.toolCallId,
              args.toolName,
              checkEntry.group.steps
            );
          } else {
            scriptedCheckFailures.push({
              toolName: args.toolName,
              reason: `widget for "${args.toolName}" did not render (${obs.status})`,
            });
          }
        }
      }
    } catch (err) {
      logger.warn(`[${scope}] widget render failed`, {
        toolName: args.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      if (checkEntry && !checkEntry.ran) {
        checkEntry.ran = true;
        scriptedCheckFailures.push({
          toolName: args.toolName,
          reason: `widget render failed for "${args.toolName}"`,
        });
      }
    }
  };

  const handleEngineToolResult = async (
    event: MCPJamToolResultEvent
  ): Promise<void> => {
    const { toolCallId, toolName, serverId } = event;
    // Feed the real tool-call args to the widget shim so the engine-path
    // render matches what the local runners (and post-turn snapshot
    // capture) inject. The entry is consumed here — once the call's result
    // has arrived nothing reads it again, so release it on every exit path
    // to keep the cache bounded over long sessions (CodeRabbit, PR 2610).
    const toolInput = inputByToolCallId.get(toolCallId);
    inputByToolCallId.delete(toolCallId);
    if (!serverId || !toolName) return;
    if (event.isError) return;
    await renderIfRenderable({
      toolCallId,
      toolName,
      serverId,
      toolInput,
      // `rawResult` is the unscrubbed implementation result; `output` on the
      // event is the LLM-facing view with `_meta` / `structuredContent`
      // scrubbed, which would starve the widget shim of its data.
      output: event.rawResult ?? event.output,
    });
  };

  const handleDirectToolResultChunk = async (
    chunk: Pick<
      DirectChatTurnToolResultChunk,
      "toolCallId" | "toolName" | "input" | "output" | "serverId"
    >
  ): Promise<void> => {
    if (!chunk.serverId) return;
    await renderIfRenderable({
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      serverId: chunk.serverId,
      // The chunk carries the already-normalized tool input inline.
      toolInput: chunk.input,
      output: chunk.output,
    });
  };

  return {
    computerUseSupported,
    computerUseVersion,
    computerWidgetTools,
    widgetRenderObservations,
    browserInteractionSteps,
    prepareAdvertisedTools,
    scriptedCheckFailures,
    drainFollowUps(): string[] {
      // Truncate each message before it drives a model turn. The driven COUNT
      // is bounded downstream by MAX_WIDGET_FOLLOWUP_TURNS; this caps a single
      // oversized `ui/message` from bloating the next LLM request.
      return capturedFollowUps.splice(0).map(truncateFollowUpText);
    },
    setActivePromptIndex(promptIndex: number): void {
      activePromptIndex = promptIndex;
    },
    setActiveAuthoredStepId(stepId: string | null): void {
      activeAuthoredStepId = stepId;
    },
    setActiveWidgetChecks(checks: ScriptedWidgetCheck[]): void {
      // Flush the previous turn's groups first (unrun ⇒ failure), then arm
      // this turn's.
      flushActiveWidgetChecks();
      activeWidgetChecks = checks.map((group) => ({ group, ran: false }));
    },
    flushActiveWidgetChecks,
    noteToolCallInput(event: { toolCallId: string; input: unknown }): void {
      if (
        event.input &&
        typeof event.input === "object" &&
        !Array.isArray(event.input)
      ) {
        inputByToolCallId.set(
          event.toolCallId,
          event.input as Record<string, unknown>
        );
      }
    },
    handleEngineToolResult,
    handleDirectToolResultChunk,
    renderPinnedToolResult(args) {
      return renderIfRenderable({ ...args, recordNonRenderable: true });
    },
    setKeepWidgetsMountedForSteps(keep: boolean): void {
      keepWidgetsMountedForSteps = keep;
    },
    get mountedWidgetToolName(): string | null {
      // Only report the live widget when the harness still has it mounted —
      // guards against a stale `mountedWidget` after an external dismiss.
      if (!mountedWidget) return null;
      const liveId = widgetHarnessRef.current?.getMountedWidgetId() ?? null;
      return liveId === mountedWidget.toolCallId
        ? mountedWidget.toolName
        : null;
    },
    async replayInteractStep(
      toolName: string,
      action: InteractAction
    ): Promise<WidgetStepOutcome> {
      const live = mountedWidget;
      const liveId = widgetHarnessRef.current?.getMountedWidgetId() ?? null;
      // Fail closed: nothing mounted, the live widget is a different tool, or
      // our tracked id drifted from the harness's actual mount.
      if (!live || live.toolName !== toolName || liveId !== live.toolCallId) {
        return {
          ok: false,
          reason: live
            ? `no mounted widget for tool "${toolName}" (live widget is "${live.toolName}")`
            : `no mounted widget for tool "${toolName}"`,
        };
      }
      return replayWidgetScriptedStep(
        live.toolCallId,
        interactActionToScriptedStep(action)
      );
    },
    async evaluateWidgetAssertion(
      toolName: string,
      assertion: WidgetAssertion
    ): Promise<WidgetStepOutcome> {
      const live = mountedWidget;
      const liveId = widgetHarnessRef.current?.getMountedWidgetId() ?? null;
      if (!live || live.toolName !== toolName || liveId !== live.toolCallId) {
        return {
          ok: false,
          reason: live
            ? `no mounted widget for tool "${toolName}" (live widget is "${live.toolName}")`
            : `no mounted widget for tool "${toolName}"`,
        };
      }
      return replayWidgetScriptedStep(live.toolCallId, {
        kind: "assert",
        assertion: widgetAssertionToStepAssertion(assertion),
      });
    },
    drainNewArtifacts() {
      const observations = widgetRenderObservations.slice(
        drainedObservationCount
      );
      const steps = browserInteractionSteps.slice(drainedStepCount);
      drainedObservationCount = widgetRenderObservations.length;
      drainedStepCount = browserInteractionSteps.length;
      return { observations, steps };
    },
    async dismissCarriedWidget(): Promise<void> {
      const carriedWidgetId =
        widgetHarnessRef.current?.getMountedWidgetId() ?? null;
      if (carriedWidgetId) {
        await widgetHarnessRef.current!.dismissWidget(carriedWidgetId);
      }
      mountedWidget = null;
    },
    async collectVideo(): Promise<Buffer | null> {
      return (await widgetHarnessRef.current?.collectVideo()) ?? null;
    },
    async dispose(): Promise<void> {
      await widgetHarnessRef.current?.dispose();
      if (widgetRenderObservations.length > 0) {
        logger.debug(`[${scope}] widget render observations`, {
          count: widgetRenderObservations.length,
          statuses: widgetRenderObservations.map((o) => o.status),
        });
      }
    },
  };
}
