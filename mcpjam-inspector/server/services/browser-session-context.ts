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
} from "../utils/mcp-app-browser-harness";
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
  type RunnerBrowserInteractionStep,
  type RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../utils/logger";

export interface CreateBrowserSessionContextParams {
  /** Driver model id — decides Computer Use availability. Mapped Claude ids
   *  resolve offline; other ids are checked against the OpenRouter catalog
   *  for vision + tool calling (see model-capabilities.ts). Omitted for
   *  model-free sessions (a pinned-tool-call / render-check iteration): no
   *  driver means no Computer Use, and the harness still renders widgets and
   *  records observations on demand. */
  model?: string;
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
  /** Runner loop bookkeeping: stamp artifacts with the active prompt turn. */
  setActivePromptIndex(promptIndex: number): void;
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
   * being silently skipped.
   */
  renderPinnedToolResult(args: {
    toolCallId: string;
    toolName: string;
    serverId: string;
    toolInput: Record<string, unknown> | undefined;
    output: unknown;
  }): Promise<void>;
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
  /** Tear down the harness (and Chromium, if launched). Always call. */
  dispose(): Promise<void>;
}

export async function createBrowserSessionContext(
  params: CreateBrowserSessionContextParams
): Promise<BrowserSessionContext> {
  const { mcpClientManager, injectOpenAiCompat } = params;
  const scope = params.logScope ?? "evals";
  // No driver model (model-free pinned-tool-call iteration) ⇒ no Computer Use;
  // skip the capability probe entirely. The harness still renders widgets.
  const computerUseVersion = params.model
    ? resolveComputerUseToolVersion(params.model)
    : null;
  // Capability gate, resolved ONCE at construction so the tool surface is
  // deterministic for the whole session/iteration: mapped Claude ids are
  // eligible offline; anything else needs vision + tool calling per the
  // OpenRouter catalog. Unknown/unreachable → no computer tools (the
  // pre-feature behavior for non-Claude drivers).
  const computerUseSupported =
    params.model != null &&
    (computerUseVersion !== null ||
      (await modelSupportsComputerUse(params.model)));

  const widgetHarnessRef: { current: McpAppBrowserHarness | null } = {
    current: null,
  };
  const widgetRenderObservations: RunnerWidgetRenderObservation[] = [];
  const browserInteractionSteps: RunnerBrowserInteractionStep[] = [];
  const stepIndexByToolCallId = new Map<string, number>();
  const inputByToolCallId = new Map<string, Record<string, unknown>>();
  let activePromptIndex = 0;
  let drainedObservationCount = 0;
  let drainedStepCount = 0;

  const ensureWidgetHarness = (): McpAppBrowserHarness => {
    if (!widgetHarnessRef.current) {
      widgetHarnessRef.current = new McpAppBrowserHarness({
        callTool: (sid, name, args) =>
          mcpClientManager.executeTool(sid, name, args),
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

  /** Shared render path: read the widget resource, mount it in the harness,
   *  record the observation. Containment contract: never throws.
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
        keepMounted: computerUseSupported,
      });
      // Stamp promptIndex at push-time — the harness type stays pure; the
      // runner loop is the single source of truth for promptIndex.
      widgetRenderObservations.push({
        ...obs,
        promptIndex: activePromptIndex,
      });
      logger.debug(`[${scope}] widget render observation`, {
        toolName: args.toolName,
        status: obs.status,
      });
    } catch (err) {
      logger.warn(`[${scope}] widget render failed`, {
        toolName: args.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
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
    setActivePromptIndex(promptIndex: number): void {
      activePromptIndex = promptIndex;
    },
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
