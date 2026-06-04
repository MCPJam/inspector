/**
 * HostRunner - Runs LLM prompts with tool calling for evals
 */

import {
  generateText,
  hasToolCall,
  stepCountIs,
  dynamicTool,
  jsonSchema,
} from "ai";
import type {
  StopCondition,
  ToolSet,
  ModelMessage,
  UserModelMessage,
  StepResult,
} from "ai";
import { createModelFromString, parseLLMString } from "./model-factory.js";
import type { CreateModelOptions } from "./model-factory.js";
import { extractToolCalls } from "./tool-extraction.js";
import { PromptResult } from "./PromptResult.js";
import type { CustomProvider, ToolCall as PromptToolCall } from "./types.js";
import type { HostExecutor, PromptOptions } from "./HostExecutor.js";
import type { Tool, AiSdkTool } from "./mcp-client-manager/types.js";
import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import type {
  EvalWidgetSnapshotInput,
  MCPServerReplayConfig,
} from "./eval-reporting-types.js";
import {
  ensureJsonSchemaObject,
  isAppOnlyTool,
} from "./mcp-client-manager/tool-converters.js";
import { assertCallToolResult } from "./mcp-client-manager/result-guards.js";
import { buildMcpAppWidgetSnapshot } from "./widget-snapshots.js";
import { injectOpenAICompat } from "./widget-helpers.js";
import {
  createEvalSpanIntegration,
  patchEvalSpansMessageRangesFromSteps,
} from "./eval-trace-spans.js";
import { snapshotHostSource } from "./host-config/host.js";
import type { HostSource } from "./host-config/host.js";
import type { HostJson } from "./host-config/public-types.js";
import {
  extractHostExecutionPolicy,
  resolveOpenAiCompatForHostConfig,
  type HostExecutionPolicy,
} from "./host-config/internal.js";


/**
 * Common fields for {@link HostRunnerConfig}. See the discriminated union
 * below for the `host` / `model` requirement: callers supply either a
 * `Host` (model + defaults come from the snapshot) or an explicit `model`
 * string (legacy path with no host-derived defaults).
 */
interface HostRunnerBaseConfig {
  /** Tools to provide to the LLM (Tool[] from manager.getTools() or AiSdkTool from manager.getToolsForAiSdk()) */
  tools: Tool[] | AiSdkTool;
  /** API key for the LLM provider */
  apiKey: string;
  /** System prompt for the LLM. Overrides the host-derived value when both are present. Defaults to "You are a helpful assistant." if neither is set. */
  systemPrompt?: string;
  /** Temperature for LLM responses (0-2). Overrides the host-derived value. Some models (e.g., reasoning models) don't support temperature. */
  temperature?: number;
  /** Maximum number of agentic steps/tool calls (default: 10) */
  maxSteps?: number;
  /** Custom providers registry for non-standard LLM providers */
  customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
  /** Optional MCP client manager for capturing MCP App replay snapshots */
  mcpClientManager?: MCPClientManager;
  /**
   * When true, the runner injects the OpenAI Apps SDK `window.openai`
   * shim into captured widget HTML so replays under hosts that expect
   * that surface (ChatGPT/Copilot or MCPJam's dev surface) render
   * unchanged. When a `host` is supplied, this defaults to the value
   * resolved from `resolveOpenAiCompatForHostConfig(hostSnapshot)`;
   * setting this field explicitly overrides that decision. Without a
   * host the default is `false` — Claude/Cursor/Codex-style hosts don't
   * expose `window.openai`, and snapshots should match what the live
   * host would have produced.
   */
  injectOpenAiCompat?: boolean;
}

/**
 * Configuration for creating a `HostRunner`. Discriminated on `host`:
 *
 * - With `host`: model / systemPrompt / temperature / injectOpenAiCompat
 *   default to host-snapshot-derived values; explicit fields override.
 *   `model` becomes optional (host snapshot supplies it).
 * - Without `host`: `model` is required and there are no host-derived
 *   defaults (legacy path, preserved for callers that don't yet have a
 *   `Host` to hand in).
 *
 * A config with neither `host` nor `model` is a compile-time error.
 */
export type HostRunnerConfig =
  | (HostRunnerBaseConfig & { host: HostSource; model?: string })
  | (HostRunnerBaseConfig & { host?: undefined; model: string });

// Re-export PromptOptions for backward compatibility
export type { PromptOptions } from "./HostExecutor.js";

/**
 * Type guard to check if tools is Tool[] (from getTools())
 */
function isToolArray(tools: Tool[] | AiSdkTool): tools is Tool[] {
  return Array.isArray(tools);
}

/**
 * Drop SEP-1865 app-only tools (`_meta.ui.visibility = ["app"]`) from a
 * `Tool[]` before conversion. Mirror of the Stage 3 `filterAppOnlyTools`
 * for AI SDK records but operating on `Tool[]` directly, since each
 * `Tool` already carries its own `_meta` (no external metadata source
 * needed).
 */
function dropAppOnlyTools(tools: Tool[]): Tool[] {
  return tools.filter(
    (tool) =>
      !isAppOnlyTool(tool._meta as Record<string, unknown> | undefined),
  );
}

/**
 * Pure converter from `Tool[]` to AI SDK `ToolSet`. Visibility filtering is
 * handled at the HostRunner prep step (single-gated by host policy), not
 * inside this converter.
 */
function convertToToolSet(tools: Tool[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const tool of tools) {
    const converted = dynamicTool({
      description: tool.description,
      inputSchema: jsonSchema(ensureJsonSchemaObject(tool.inputSchema)),
      execute: async (args, options) => {
        options?.abortSignal?.throwIfAborted?.();
        const result = await tool.execute(args as Record<string, unknown>);
        return assertCallToolResult(result, `Tool "${tool.name}" result`);
      },
    });

    // Preserve _serverId like getToolsForAiSdk() does
    if (tool._meta?._serverId) {
      (converted as any)._serverId = tool._meta._serverId;
    }

    toolSet[tool.name] = converted;
  }
  return toolSet;
}

type StartedToolCall = {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  shortCircuited: boolean;
};


/**
 * Synchronous executor that runs LLM prompts with tool calling. Wraps the
 * AI SDK `generateText` and applies the host-derived execution policy
 * (visibility filtering, OpenAI compat injection) at construction time.
 *
 * Implements {@link HostExecutor} so it plugs into `EvalTest.run(...)` /
 * `EvalSuite.run(...)` interchangeably with `HostRuntime`.
 *
 * @example
 * ```typescript
 * const manager = new MCPClientManager({
 *   everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
 * });
 * await manager.connectToServer("everything");
 *
 * const runner = new HostRunner({
 *   tools: await manager.getToolsForAiSdk(["everything"]),
 *   model: "openai/gpt-4o",
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 *
 * const result = await runner.run("Add 2 and 3");
 * console.log(result.toolsCalled()); // ["add"]
 * console.log(result.text); // "The result of adding 2 and 3 is 5."
 * ```
 */
export class HostRunner implements HostExecutor {
  private readonly tools: ToolSet;
  private readonly model: string;
  private readonly apiKey: string;
  private systemPrompt: string;
  private temperature: number | undefined;
  private readonly maxSteps: number;
  private readonly customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
  private readonly mcpClientManager?: MCPClientManager;
  private readonly injectOpenAiCompat: boolean;

  /**
   * Immutable host snapshot driving this runner, if constructed with a
   * `host`. Taken once at construction (via {@link snapshotHostSource}, which
   * passes a pre-snapshotted `HostJson` through unchanged so `HostRuntime`
   * does not double-snapshot). Post-construction mutations to the original
   * `Host` instance do NOT affect this runner.
   */
  private readonly hostSnapshot: HostJson | undefined;

  /**
   * Cached execution policy derived from {@link hostSnapshot}. `undefined`
   * when no host was supplied (legacy explicit-model path).
   */
  private readonly hostPolicy: HostExecutionPolicy | undefined;

  /** Normalized provider name parsed from the model string */
  private readonly _parsedProvider: string;
  /** Normalized model name parsed from the model string */
  private readonly _parsedModel: string;

  /** The result of the last prompt (for toolsCalled() convenience method) */
  private lastResult: PromptResult | undefined;

  /** History of all prompt results during a test execution */
  private promptHistory: PromptResult[] = [];

  /**
   * Create a new HostRunner
   * @param config - Agent configuration
   */
  constructor(config: HostRunnerConfig) {
    // Snapshot the host once if provided. `snapshotHostSource` is idempotent
    // — a pre-snapshotted `HostJson` (e.g. from `HostRuntime.run()`) passes
    // through without re-snapshotting.
    this.hostSnapshot = config.host
      ? snapshotHostSource(config.host)
      : undefined;
    this.hostPolicy = this.hostSnapshot
      ? extractHostExecutionPolicy(
          this.hostSnapshot as unknown as Record<string, unknown>,
        )
      : undefined;

    // Resolve the model: explicit field wins; otherwise pull from host
    // snapshot; if neither, the discriminated-union types should have
    // rejected this at compile time — runtime throw as a defense in depth.
    const resolvedModel = config.model ?? this.hostSnapshot?.model;
    if (!resolvedModel) {
      throw new Error(
        "HostRunner requires either `host` (with a configured model) or an explicit `model` string.",
      );
    }

    // Single-gate SEP-1865 app-only visibility filtering. Default behavior
    // (no host / undefined respectToolVisibility) is to drop app-only tools,
    // matching pre-Stage-4 semantics. `host.respectToolVisibility = false`
    // is the explicit opt-out for hosts that don't implement visibility.
    //
    // The `AiSdkTool` branch is intentionally pass-through: callers obtain
    // it via `MCPClientManager.getToolsForAiSdk(...)`, which applies its
    // own `includeAppOnly` flag at construction. `HostRuntime` plumbs the
    // host policy into that flag, so by the time tools land here they have
    // already been gated correctly — re-filtering would be a double-gate.
    const respectVisibility =
      this.hostPolicy?.respectToolVisibility !== false;
    const preparedTools = isToolArray(config.tools)
      ? respectVisibility
        ? dropAppOnlyTools(config.tools)
        : config.tools
      : config.tools;

    this.tools = isToolArray(preparedTools)
      ? convertToToolSet(preparedTools)
      : preparedTools;
    this.model = resolvedModel;
    this.apiKey = config.apiKey;
    this.systemPrompt =
      config.systemPrompt ??
      (this.hostSnapshot?.systemPrompt && this.hostSnapshot.systemPrompt !== ""
        ? this.hostSnapshot.systemPrompt
        : "You are a helpful assistant.");
    this.temperature =
      config.temperature ?? this.hostSnapshot?.temperature;
    this.maxSteps = config.maxSteps ?? 10;
    this.customProviders = config.customProviders;
    this.mcpClientManager = config.mcpClientManager;
    this.injectOpenAiCompat =
      config.injectOpenAiCompat ??
      (this.hostSnapshot
        ? resolveOpenAiCompatForHostConfig(this.hostSnapshot) === true
        : false);

    // Parse the model string once to extract provider/model metadata
    try {
      const parsed = parseLLMString(resolvedModel);
      this._parsedProvider =
        parsed.type === "builtin" ? parsed.provider : parsed.providerName;
      this._parsedModel = parsed.model;
    } catch {
      // Fallback for unparseable model strings (e.g., mock agents)
      const parts = resolvedModel.split("/");
      this._parsedProvider = parts.length > 1 ? parts[0] : "";
      this._parsedModel =
        parts.length > 1 ? parts.slice(1).join("/") : resolvedModel;
    }
  }

  /**
   * Create instrumented tools that track execution latency.
   * @param onLatency - Callback to report latency for each tool execution
   * @returns ToolSet with instrumented execute functions
   */
  private warnWidgetSnapshotFailure(
    toolName: string,
    message: string,
    error?: unknown
  ) {
    const suffix =
      error instanceof Error
        ? `: ${error.message}`
        : error
          ? `: ${String(error)}`
          : "";
    console.warn(
      `[mcpjam/sdk] skipped widget snapshot for "${toolName}"${suffix || `: ${message}`}`
    );
  }

  private async captureMcpAppSnapshot(params: {
    toolName: string;
    tool: ToolSet[string];
    options: { toolCallId?: string } | undefined;
    toolInput: Record<string, unknown>;
    toolOutput: unknown;
    snapshotBuffer: Map<string, EvalWidgetSnapshotInput>;
  }) {
    if (!this.mcpClientManager) {
      return;
    }
    // The HostRuntime path accepts a structural `HostRuntimeManager`
    // that only requires `hasServer` + `getToolsForAiSdk`. Widget
    // snapshot capture additionally needs `getToolMetadata` and
    // `readResource` — defensively skip capture for managers that
    // don't expose them rather than crash an otherwise-successful run.
    // The concrete `MCPClientManager` always satisfies this; custom
    // structural managers that don't implement the metadata/resource
    // pair just fall through silently, matching the "no manager"
    // semantics above.
    const manager = this.mcpClientManager as MCPClientManager & {
      getToolMetadata?: MCPClientManager["getToolMetadata"];
      readResource?: MCPClientManager["readResource"];
    };
    if (
      typeof manager.getToolMetadata !== "function" ||
      typeof manager.readResource !== "function"
    ) {
      return;
    }

    const toolCallId =
      typeof params.options?.toolCallId === "string"
        ? params.options.toolCallId
        : undefined;
    if (!toolCallId) {
      return;
    }

    const serverId = (params.tool as any)._serverId;
    if (typeof serverId !== "string" || !serverId) {
      return;
    }

    const toolMetadata = manager.getToolMetadata(
      serverId,
      params.toolName
    );
    if (!toolMetadata) {
      return;
    }

    const ui = toolMetadata.ui as { resourceUri?: string } | undefined;
    const resourceUri =
      typeof ui?.resourceUri === "string" ? ui.resourceUri : undefined;
    if (!resourceUri) {
      return;
    }

    try {
      const resourceResult = await manager.readResource(
        serverId,
        {
          uri: resourceUri,
        }
      );
      const contents = Array.isArray((resourceResult as any)?.contents)
        ? (resourceResult as any).contents
        : [];
      const content = contents[0];
      if (!content) {
        this.warnWidgetSnapshotFailure(
          params.toolName,
          "resource read returned no content"
        );
        return;
      }

      const snapshot = buildMcpAppWidgetSnapshot({
        toolCallId,
        toolName: params.toolName,
        serverId,
        resourceUri,
        toolMetadata,
        resourceContent: content,
      });
      if (!snapshot) {
        this.warnWidgetSnapshotFailure(
          params.toolName,
          "resource did not contain HTML content"
        );
        return;
      }

      // Optionally inject the OpenAI Apps SDK `window.openai` shim into
      // the captured HTML. Default off so snapshots match SEP-1865
      // honest behavior; callers emulating ChatGPT/Copilot or MCPJam's
      // dev surface opt in via `HostRunnerConfig.injectOpenAiCompat`.
      if (this.injectOpenAiCompat) {
        snapshot.widgetHtml = injectOpenAICompat(snapshot.widgetHtml ?? "", {
          toolId: toolCallId,
          toolName: params.toolName,
          toolInput: params.toolInput ?? {},
          toolOutput: params.toolOutput,
          theme: "dark",
          viewMode: "inline",
          viewParams: {},
        });
      }
      snapshot.injectedOpenAiCompat = this.injectOpenAiCompat;

      params.snapshotBuffer.set(toolCallId, snapshot);
    } catch (error) {
      this.warnWidgetSnapshotFailure(
        params.toolName,
        "resource read failed",
        error
      );
    }
  }

  private createInstrumentedTools(
    onLatency: (ms: number) => void,
    snapshotBuffer: Map<string, EvalWidgetSnapshotInput>,
    pendingStepToolCalls: StartedToolCall[],
    shortCircuitTools?: Set<string>
  ): ToolSet {
    const instrumented: ToolSet = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      // Only instrument tools that have an execute function
      if (tool.execute) {
        const originalExecute = tool.execute;
        instrumented[name] = {
          ...tool,
          execute: async (args: any, options: any) => {
            const start = Date.now();
            const toolCallId =
              typeof options?.toolCallId === "string"
                ? options.toolCallId
                : `${name}-${pendingStepToolCalls.length + 1}`;
            const toolInput = (args ?? {}) as Record<string, unknown>;
            const shouldShortCircuit = shortCircuitTools?.has(name) ?? false;

            pendingStepToolCalls.push({
              toolCallId,
              toolName: name,
              arguments: toolInput,
              shortCircuited: shouldShortCircuit,
            });

            try {
              if (shouldShortCircuit) {
                return assertCallToolResult({
                  content: [
                    {
                      type: "text",
                      text: "[skipped by stopAfterToolCall]",
                    },
                  ],
                }, `Tool "${name}" short-circuit result`);
              }

              const result = await originalExecute(args, options);
              await this.captureMcpAppSnapshot({
                toolName: name,
                tool,
                options,
                toolInput,
                toolOutput: result,
                snapshotBuffer,
              });
              return result;
            } finally {
              onLatency(Date.now() - start);
            }
          },
        };
      } else {
        // Pass through tools without execute function unchanged
        instrumented[name] = tool;
      }
    }
    return instrumented;
  }

  private resolveStopWhen(
    stopWhen?: PromptOptions["stopWhen"],
    stopAfterToolCall?: PromptOptions["stopAfterToolCall"]
  ): Array<StopCondition<ToolSet>> {
    const base = [stepCountIs(this.maxSteps)];
    const conditions =
      stopWhen == null ? [] : Array.isArray(stopWhen) ? stopWhen : [stopWhen];
    const stopAfterConditions = this.normalizeStopAfterToolCall(
      stopAfterToolCall
    ).map((toolName) => hasToolCall(toolName));

    return [...base, ...conditions, ...stopAfterConditions];
  }

  private normalizeStopAfterToolCall(
    stopAfterToolCall?: PromptOptions["stopAfterToolCall"]
  ): string[] {
    if (stopAfterToolCall == null) {
      return [];
    }

    return Array.isArray(stopAfterToolCall)
      ? stopAfterToolCall
      : [stopAfterToolCall];
  }

  private buildPartialAssistantMessages(
    pendingStepToolCalls: StartedToolCall[]
  ): ModelMessage[] {
    if (pendingStepToolCalls.length === 0) {
      return [];
    }

    return [
      {
        role: "assistant",
        content: pendingStepToolCalls.map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.arguments,
        })),
      },
    ];
  }

  /**
   * Build an array of ModelMessages from previous PromptResult(s) for multi-turn context.
   * @param context - Single PromptResult or array of PromptResults to include as context
   * @returns Array of ModelMessages representing the conversation history
   */
  private buildContextMessages(
    context: PromptResult | PromptResult[] | undefined
  ): ModelMessage[] {
    if (!context) {
      return [];
    }

    const results = Array.isArray(context) ? context : [context];
    const messages: ModelMessage[] = [];

    for (const result of results) {
      // Get all messages from this prompt result (user message + assistant/tool responses)
      messages.push(...result.getMessages());
    }

    return messages;
  }

  /**
   * Run a prompt with the LLM, allowing tool calls.
   * Never throws - errors are returned in the PromptResult.
   *
   * @param message - The user message to send to the LLM
   * @param options - Optional settings including context for multi-turn conversations
   * @returns PromptResult with text response, tool calls, token usage, and latency breakdown
   *
   * @example
   * // Single-turn (default)
   * const result = await runner.run("Show me projects");
   *
   * @example
   * // Multi-turn with context
   * const r1 = await runner.run("Show me projects");
   * const r2 = await runner.run("Now show tasks", { context: r1 });
   *
   * @example
   * // Multi-turn with multiple context results
   * const r1 = await runner.run("Show projects");
   * const r2 = await runner.run("Pick the first", { context: r1 });
   * const r3 = await runner.run("Show tasks", { context: [r1, r2] });
   */
  async run(
    message: string,
    options?: PromptOptions
  ): Promise<PromptResult> {
    const startTime = Date.now();
    let totalMcpMs = 0;
    let lastStepEndTime = startTime;
    let totalLlmMs = 0;
    let stepMcpMs = 0; // MCP time within current step
    const widgetSnapshots = new Map<string, EvalWidgetSnapshotInput>();
    const completedToolCalls: PromptToolCall[] = [];
    const pendingStepToolCalls: StartedToolCall[] = [];
    let lastCompletedStepMessages: ModelMessage[] = [];
    let partialInputTokens = 0;
    let partialOutputTokens = 0;
    let lastCompletedStepText = "";

    // Build tool name → serverId map for span metadata
    const serverIdByTool = new Map<string, string>();
    for (const [name, tool] of Object.entries(this.tools)) {
      const sid = (tool as any)?._serverId;
      if (typeof sid === "string" && sid) {
        serverIdByTool.set(name, sid);
      }
    }

    const spanIntegration = createEvalSpanIntegration({
      rel: () => Date.now() - startTime,
      serverIdByTool,
    });

    try {
      const modelOptions: CreateModelOptions = {
        apiKey: this.apiKey,
        customProviders: this.customProviders,
      };
      const model = createModelFromString(this.model, modelOptions);
      const stopAfterToolCallNames = this.normalizeStopAfterToolCall(
        options?.stopAfterToolCall
      );

      // Instrument tools to track MCP execution time and widget snapshots
      const instrumentedTools = this.createInstrumentedTools(
        (ms) => {
          totalMcpMs += ms;
          stepMcpMs += ms; // Accumulate per-step for LLM calculation
        },
        widgetSnapshots,
        pendingStepToolCalls,
        new Set(stopAfterToolCallNames)
      );

      // Build messages array if context is provided for multi-turn
      const contextMessages = this.buildContextMessages(options?.context);
      const userMessage: UserModelMessage = { role: "user", content: message };
      const resolvedTimeout = options?.timeout ?? options?.timeoutMs;

      const generateTextOptions: any = {
        model: model as any,
        tools: instrumentedTools,
        system: this.systemPrompt,
        // Use messages array for multi-turn, simple prompt for single-turn
        ...(contextMessages.length > 0
          ? { messages: [...contextMessages, userMessage] }
          : { prompt: message }),
        // Only include temperature if explicitly set (some models like reasoning models don't support it)
        ...(this.temperature !== undefined && {
          temperature: this.temperature,
        }),
        ...(options?.abortSignal !== undefined && {
          abortSignal: options.abortSignal,
        }),
        ...(resolvedTimeout !== undefined && {
          timeout: resolvedTimeout,
        }),
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: false,
          recordOutputs: false,
          integrations: [spanIntegration],
        },
        stopWhen: this.resolveStopWhen(
          options?.stopWhen,
          options?.stopAfterToolCall
        ),
        onStepFinish: (stepResult: StepResult<ToolSet>) => {
          const now = Date.now();
          const stepDuration = now - lastStepEndTime;
          // LLM time for this step = step duration - MCP time in this step
          totalLlmMs += Math.max(0, stepDuration - stepMcpMs);
          lastStepEndTime = now;
          stepMcpMs = 0; // Reset for next step

          if (!stepResult) {
            return;
          }

          const stepMessages = stepResult.response?.messages
            ? [...stepResult.response.messages]
            : [];

          partialInputTokens += stepResult.usage?.inputTokens ?? 0;
          partialOutputTokens += stepResult.usage?.outputTokens ?? 0;
          lastCompletedStepText = stepResult.text ?? "";
          lastCompletedStepMessages = stepMessages;
          completedToolCalls.push(
            ...stepResult.toolCalls.map((toolCall) => ({
              toolName: toolCall.toolName,
              arguments: (toolCall.input ?? {}) as Record<string, unknown>,
            }))
          );
          pendingStepToolCalls.length = 0;
        },
      };

      const result = await generateText(generateTextOptions);

      const e2eMs = Date.now() - startTime;
      const toolCalls = extractToolCalls(result);
      const usage = result.totalUsage ?? result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;

      const messages: ModelMessage[] = [];
      messages.push(userMessage);

      // Add response messages (assistant + tool messages from agentic loop)
      if (result.response?.messages) {
        messages.push(...result.response.messages);
      }

      const recordedSpans = spanIntegration.getSpans();
      patchEvalSpansMessageRangesFromSteps(
        recordedSpans,
        1,
        result.steps as ReadonlyArray<
          { response?: { messages?: ModelMessage[] } } | undefined
        >
      );

      this.lastResult = PromptResult.from({
        prompt: message,
        messages,
        text: result.text,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        latency: { e2eMs, llmMs: totalLlmMs, mcpMs: totalMcpMs },
        provider: this._parsedProvider,
        model: this._parsedModel,
        widgetSnapshots: Array.from(widgetSnapshots.values()),
        spans: recordedSpans,
      });

      this.promptHistory.push(this.lastResult);
      return this.lastResult;
    } catch (error) {
      const e2eMs = Date.now() - startTime;
      const abortReason = options?.abortSignal?.aborted
        ? options.abortSignal.reason
        : undefined;
      const errorMessage =
        abortReason instanceof Error
          ? abortReason.message
          : abortReason != null
            ? String(abortReason)
            : error instanceof Error
              ? error.message
              : String(error);
      spanIntegration.finalizeFailure(errorMessage);
      const partialMessages: ModelMessage[] = [
        { role: "user", content: message },
        ...lastCompletedStepMessages,
        ...this.buildPartialAssistantMessages(pendingStepToolCalls),
      ];
      const partialToolCalls = [
        ...completedToolCalls,
        ...pendingStepToolCalls.map((toolCall) => ({
          toolName: toolCall.toolName,
          arguments: toolCall.arguments,
        })),
      ];
      const totalTokens = partialInputTokens + partialOutputTokens;

      this.lastResult = PromptResult.from({
        prompt: message,
        messages: partialMessages,
        text: lastCompletedStepText,
        toolCalls: partialToolCalls,
        usage: {
          inputTokens: partialInputTokens,
          outputTokens: partialOutputTokens,
          totalTokens,
        },
        latency: {
          e2eMs,
          llmMs: totalLlmMs,
          mcpMs: totalMcpMs,
        },
        error: errorMessage,
        provider: this._parsedProvider,
        model: this._parsedModel,
        widgetSnapshots: Array.from(widgetSnapshots.values()),
        spans: spanIntegration.getSpans(),
      });
      this.promptHistory.push(this.lastResult);
      return this.lastResult;
    }
  }

  /**
   * Get the names of tools called in the last prompt.
   * Convenience method for quick checks in eval functions.
   *
   * @returns Array of tool names from the last prompt, or empty array if no prompt has been run
   */
  toolsCalled(): string[] {
    if (!this.lastResult) {
      return [];
    }
    return this.lastResult.toolsCalled();
  }

  /**
   * Create a new HostRunner with modified options.
   * Useful for creating variants for different test scenarios.
   *
   * @param options - Partial config to override
   * @returns A new HostRunner instance with the merged configuration
   */
  withOptions(options: Partial<HostRunnerConfig>): HostRunner {
    // Two modes:
    //
    //   1. `withOptions({})` / `withOptions({ apiKey, ... })` — no host
    //      change. Preserve the parent's resolved `model`,
    //      `systemPrompt`, `temperature`, and `injectOpenAiCompat` so
    //      `EvalTest`'s per-iteration `executor.withOptions({})` clone
    //      does NOT silently revert an explicit override applied via
    //      the parent's ctor (e.g. `new HostRunner({ host, model: "X" })`
    //      would otherwise clone with `model: undefined` and resolve
    //      back to `host.model`).
    //
    //   2. `withOptions({ host: newHost, ... })` — host is being
    //      REPLACED. The new host is meant to drive defaults, so do NOT
    //      carry the parent's resolved values; let the new host's
    //      snapshot supply `model` / `systemPrompt` / `temperature` /
    //      `injectOpenAiCompat`. Explicit `options.*` still wins.
    //      Otherwise `withOptions({ host: newHost })` would surprise
    //      with `getHostSnapshot().model === newHost.model` but the
    //      runner actually executing against the parent's old model.
    const replacingHost = options.host !== undefined;
    const carryParent = !replacingHost;
    const nextHost = options.host ?? this.hostSnapshot;

    const nextModel =
      options.model ?? (carryParent ? this.model : undefined);
    const nextSystemPrompt =
      options.systemPrompt ?? (carryParent ? this.systemPrompt : undefined);
    const nextTemperature =
      options.temperature ?? (carryParent ? this.temperature : undefined);
    const nextInjectOpenAiCompat =
      options.injectOpenAiCompat ??
      (carryParent ? this.injectOpenAiCompat : undefined);

    const base = {
      tools: options.tools ?? this.tools,
      apiKey: options.apiKey ?? this.apiKey,
      maxSteps: options.maxSteps ?? this.maxSteps,
      customProviders: options.customProviders ?? this.customProviders,
      mcpClientManager: options.mcpClientManager ?? this.mcpClientManager,
      systemPrompt: nextSystemPrompt,
      temperature: nextTemperature,
      injectOpenAiCompat: nextInjectOpenAiCompat,
    };

    if (nextHost) {
      return new HostRunner({ ...base, host: nextHost, model: nextModel });
    }
    if (!nextModel) {
      // Unreachable in normal use: the parent runner already had a model
      // (constructor guarantees one) and `carryParent` is true here
      // (since `replacingHost` is false). Belt-and-braces for the
      // hypothetical case where a caller tries to drop the host and
      // model simultaneously.
      throw new Error(
        "HostRunner.withOptions: cannot drop both `host` and `model` from a host-backed runner.",
      );
    }
    return new HostRunner({ ...base, model: nextModel });
  }

  /**
   * Get the configured tools
   */
  getTools(): ToolSet {
    return this.tools;
  }

  /**
   * Get the LLM provider/model string
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get the API key
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Get the current system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Set a new system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the current temperature (undefined means model default)
   */
  getTemperature(): number | undefined {
    return this.temperature;
  }

  /**
   * Set the temperature (must be between 0 and 2)
   */
  setTemperature(temperature: number): void {
    if (temperature < 0 || temperature > 2) {
      throw new Error("Temperature must be between 0 and 2");
    }
    this.temperature = temperature;
  }

  /**
   * Get the max steps configuration
   */
  getMaxSteps(): number {
    return this.maxSteps;
  }

  /**
   * Get replayable server configs from the attached MCP client manager.
   */
  getServerReplayConfigs(): MCPServerReplayConfig[] | undefined {
    return this.mcpClientManager?.getServerReplayConfigs();
  }

  /**
   * Get the result of the last prompt
   */
  getLastResult(): PromptResult | undefined {
    return this.lastResult;
  }

  /**
   * Reset the prompt history.
   * Call this before each test iteration to clear previous results.
   */
  resetPromptHistory(): void {
    this.promptHistory = [];
    this.lastResult = undefined;
  }

  /**
   * Get the history of all prompt results since the last reset.
   * Returns a copy of the array to prevent external modification.
   */
  getPromptHistory(): PromptResult[] {
    return [...this.promptHistory];
  }

  /**
   * Return the immutable `HostJson` snapshot driving this runner, or
   * `undefined` if the runner was constructed with an explicit `model`
   * rather than a `host`. The snapshot is taken at construction and
   * post-construction mutations to the original `Host` are not reflected.
   */
  getHostSnapshot(): HostJson | undefined {
    return this.hostSnapshot;
  }

  /**
   * Return the resolved execution policy (visibility, progressive discovery,
   * tool-exposure signals) derived from the host snapshot at construction
   * time. `undefined` when constructed without a `host`.
   */
  getHostPolicy(): HostExecutionPolicy | undefined {
    return this.hostPolicy;
  }

  /**
   * Get the normalized provider name parsed from the model string.
   */
  getParsedProvider(): string {
    return this._parsedProvider;
  }

  /**
   * Get the normalized model name parsed from the model string.
   */
  getParsedModel(): string {
    return this._parsedModel;
  }

  /**
   * Create a mock executor for deterministic eval tests. The mock calls
   * the provided function instead of making real LLM calls, and satisfies
   * {@link HostExecutor} so it can be passed to `EvalTest.run` /
   * `EvalSuite.run` directly.
   *
   * @param promptFn - Function that returns a PromptResult for a given message
   * @returns A HostExecutor compatible with EvalTest / EvalSuite
   *
   * @example
   * ```typescript
   * const runner = HostRunner.mock(async (message) =>
   *   PromptResult.from({
   *     prompt: message,
   *     messages: [{ role: "user", content: message }],
   *     text: "mocked response",
   *     toolCalls: [{ toolName: "my_tool", arguments: {} }],
   *     usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
   *     latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
   *   })
   * );
   *
   * const test = new EvalTest({
   *   name: "my-test",
   *   test: async (executor) => {
   *     const r = await executor.run("test");
   *     return r.hasToolCall("my_tool");
   *   },
   * });
   * await test.run(runner, { iterations: 3 });
   * ```
   */
  static mock(
    promptFn: (
      message: string,
      options?: PromptOptions
    ) => PromptResult | Promise<PromptResult>
  ): HostExecutor {
    const createAgent = (): HostExecutor => {
      let promptHistory: PromptResult[] = [];

      return {
        run: async (message: string, options?: PromptOptions) => {
          const result = await promptFn(message, options);
          promptHistory.push(result);
          return result;
        },
        resetPromptHistory: () => {
          promptHistory = [];
        },
        getPromptHistory: () => [...promptHistory],
        withOptions: () => createAgent(),
      };
    };

    return createAgent();
  }
}
