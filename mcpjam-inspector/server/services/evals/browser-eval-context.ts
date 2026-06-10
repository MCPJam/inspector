/**
 * browser-eval-context.ts — per-iteration browser-rendered MCP App context for
 * the HOSTED eval runner paths (PR 14).
 *
 * `runIterationViaBackend` / `streamIterationViaBackend` drive their turns
 * through the shared engine (`runAssistantTurn` → `runChatEngineLoop`), so the
 * harness wiring that the local AI-SDK runners inline (PR 5/6b/9) attaches via
 * the engine's extension points instead:
 *
 *   - `computerWidgetTools` — wire-format `computer` + `finish_widget` tools
 *     (regular function tools; the provider-native factory's lazy schema
 *     serializes to an empty object on the Convex `/stream` wire). Merged into
 *     the tool map the runner passes to `runAssistantTurn`, executed locally by
 *     `executeToolCallsFromMessages`, with screenshots reaching the model as
 *     image content via the tool's `toModelOutput` (honored by the shared
 *     executor since PR 14).
 *   - `prepareAdvertisedTools` — hides both tools until a widget is actually
 *     mounted in the harness (same gate the local runners use; the engine
 *     additionally enforces execution against the advertised subset).
 *   - `handleEngineToolResult` — the engine's `onToolResult` hook (awaited by
 *     `emitToolResults` since PR 14, so a rendered widget is mounted before the
 *     next step's gate runs). Renders MCP App tool results in the harness and
 *     records `RunnerWidgetRenderObservation`s.
 *   - `noteToolCallInput` — the engine's `onToolCall` hook; caches tool-call
 *     inputs so the render hook can feed the OpenAI-compat shim the same
 *     `toolInput` the live widget would have received.
 *
 * One context per iteration; `dispose()` MUST run (callers wrap the iteration
 * body in try/finally) so a launched Chromium never outlives its iteration.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolSet } from "ai";
import {
  DEFAULT_VIEWPORT,
  McpAppBrowserHarness,
} from "../../utils/mcp-app-browser-harness";
import {
  buildComputerUseTools,
  resolveComputerUseToolVersion,
} from "../../utils/computer-use-tool";
import {
  isRenderableMcpAppTool,
  renderMcpAppToolResult,
} from "../../utils/mcp-app-render-observation";
import type { MCPJamToolResultEvent } from "../../utils/mcpjam-stream-handler.js";
import type { PrepareAdvertisedTools } from "../../utils/advertised-tools";
import {
  isEvalTraceBrowserStepNote,
  type RunnerBrowserInteractionStep,
  type RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger";

export interface CreateEvalBrowserContextParams {
  /** Driver model id (`test.model`) — decides Computer Use availability. */
  model: string;
  mcpClientManager: MCPClientManager;
  injectOpenAiCompat?: boolean;
}

export interface EvalBrowserContext {
  /** Non-null exactly when the driver model supports Computer Use. */
  readonly computerUseVersion: ReturnType<typeof resolveComputerUseToolVersion>;
  /** Wire-format `computer` + `finish_widget`, or `{}` for non-Claude drivers. */
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
  /** Start-of-turn hygiene: a widget kept mounted by a previous prompt turn
   *  must not bleed into this one. */
  dismissCarriedWidget(): Promise<void>;
  /** Tear down the harness (and Chromium, if launched). Always call. */
  dispose(): Promise<void>;
}

export function createEvalBrowserContext(
  params: CreateEvalBrowserContextParams,
): EvalBrowserContext {
  const { mcpClientManager, injectOpenAiCompat } = params;
  const computerUseVersion = resolveComputerUseToolVersion(params.model);

  const widgetHarnessRef: { current: McpAppBrowserHarness | null } = {
    current: null,
  };
  const widgetRenderObservations: RunnerWidgetRenderObservation[] = [];
  const browserInteractionSteps: RunnerBrowserInteractionStep[] = [];
  const stepIndexByToolCallId = new Map<string, number>();
  const inputByToolCallId = new Map<string, Record<string, unknown>>();
  let activePromptIndex = 0;

  const ensureWidgetHarness = (): McpAppBrowserHarness => {
    if (!widgetHarnessRef.current) {
      widgetHarnessRef.current = new McpAppBrowserHarness({
        callTool: (sid, name, args) =>
          mcpClientManager.executeTool(sid, name, args),
        viewport: DEFAULT_VIEWPORT,
      });
    }
    return widgetHarnessRef.current;
  };
  // Eager (cheap) construction when Computer Use is supported so the computer
  // tools can reference the harness; Chromium still launches lazily on the
  // first widget render.
  if (computerUseVersion) ensureWidgetHarness();

  const computerWidgetTools: ToolSet = computerUseVersion
    ? buildComputerUseTools({
        version: computerUseVersion,
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
        // base64 here; finalizeEvalIteration uploads it once for both the W2
        // and W1 persistence paths.
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
              logger.warn("[evals] dropping unknown browser-step note", {
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
    computerUseVersion
      ? ({ defaultToolNames }) =>
          widgetHarnessRef.current?.getMountedWidgetId()
            ? defaultToolNames
            : defaultToolNames.filter(
                (n) => n !== "computer" && n !== "finish_widget",
              )
      : undefined;

  const handleEngineToolResult = async (
    event: MCPJamToolResultEvent,
  ): Promise<void> => {
    const { toolCallId, toolName, serverId } = event;
    if (!serverId || !toolName) return;
    if (event.isError) return;
    const meta = mcpClientManager.getAllToolsMetadata(serverId)?.[toolName];
    if (!isRenderableMcpAppTool(meta)) return;
    try {
      const obs = await renderMcpAppToolResult({
        toolCallId,
        toolName,
        serverId,
        toolMetadata: meta,
        // Feed the real tool-call args to the widget shim so the hosted-path
        // render matches what the local runners (and post-turn snapshot
        // capture) inject.
        toolInput: inputByToolCallId.get(toolCallId),
        // `rawResult` is the unscrubbed implementation result; `output` on the
        // event is the LLM-facing view with `_meta` / `structuredContent`
        // scrubbed, which would starve the widget shim of its data.
        output: event.rawResult ?? event.output,
        mcpClientManager,
        injectOpenAiCompat,
        harness: ensureWidgetHarness(),
        keepMounted: computerUseVersion !== null,
      });
      // Stamp promptIndex at push-time — the harness type stays pure; the
      // runner loop is the single source of truth for promptIndex.
      widgetRenderObservations.push({
        ...obs,
        promptIndex: activePromptIndex,
      });
      logger.debug("[evals] widget render observation (hosted path)", {
        toolName,
        status: obs.status,
      });
    } catch (err) {
      logger.warn("[evals] widget render failed (hosted path)", {
        toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
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
          event.input as Record<string, unknown>,
        );
      }
    },
    handleEngineToolResult,
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
        logger.debug("[evals] widget render observations (hosted path)", {
          count: widgetRenderObservations.length,
          statuses: widgetRenderObservations.map((o) => o.status),
        });
      }
    },
  };
}
