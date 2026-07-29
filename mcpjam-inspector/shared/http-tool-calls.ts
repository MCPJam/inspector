import { ModelMessage } from "@ai-sdk/provider-utils";
import {
  type McpLinkedResourceReader,
  type McpModelVisibleToolResultPolicy,
  type MCPClientManager,
  MCP_PRESERVE_RAW_RESULT_FOR_UI,
  isMcpAppTool,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  scrubMetaAndStructuredContentFromToolResult,
} from "@mcpjam/sdk";
import { ToolResultPart } from "ai";
import { isAbortError } from "./abort-errors";
import { isMrtrSuspendSignalShape } from "./mrtr-continuation";
import { isClientFulfilledToolName } from "./client-fulfilled-tools";
import { mergeMcpToolOriginMetadata } from "./mcp-tool-origin-metadata";

type ToolsMap = Record<string, any>;
type Toolsets = Record<string, ToolsMap>;

/**
 * Flatten toolsets and attach serverId metadata to each tool
 * This preserves the server origin for each tool to enable correct routing
 */
function flattenToolsetsWithServerId(toolsets: Toolsets): ToolsMap {
  const flattened: ToolsMap = {};
  for (const [serverId, serverTools] of Object.entries(toolsets || {})) {
    if (serverTools && typeof serverTools === "object") {
      for (const [toolName, tool] of Object.entries(serverTools)) {
        // Attach serverId metadata to each tool
        flattened[toolName] = {
          ...tool,
          _serverId: serverId,
        };
      }
    }
  }
  return flattened;
}

function buildIndexWithAliases(tools: ToolsMap): ToolsMap {
  const index: ToolsMap = {};
  for (const [toolName, tool] of Object.entries<any>(tools || {})) {
    if (!tool || typeof tool !== "object" || !("execute" in tool)) continue;
    const idx = toolName.indexOf("_");
    const pure =
      idx > -1 && idx < toolName.length - 1
        ? toolName.slice(idx + 1)
        : toolName;
    if (!(toolName in index)) index[toolName] = tool;
    if (!(pure in index)) index[pure] = tool;
  }
  return index;
}

function makeAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw makeAbortError(signal);
  }
}

function shouldPreserveRawResultForUi(tool: unknown): boolean {
  return (
    !!tool &&
    typeof tool === "object" &&
    (tool as Record<string, unknown>)[MCP_PRESERVE_RAW_RESULT_FOR_UI] === true
  );
}

async function maybeMcpModelOutput(
  result: unknown,
  options: McpModelVisibleToolResultPolicy & {
    readResource?: McpLinkedResourceReader;
    abortSignal?: AbortSignal;
  }
): Promise<ToolResultPart | undefined> {
  if (!result || typeof result !== "object") return undefined;
  if (options.readResource) {
    return (await mcpCallToolResultToModelOutputWithLinkedResources(
      result as any,
      {
        modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
        readResource: options.readResource,
        abortSignal: options.abortSignal,
      }
    )) as any;
  }
  return mcpCallToolResultToModelOutput(result as any, {
    modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
  }) as any;
}

function isSkippableClientFulfilledToolCall(
  toolName: string,
  tool: unknown,
  skipNonExecutableTools: boolean | undefined
): boolean {
  return (
    skipNonExecutableTools === true &&
    isClientFulfilledToolName(toolName) &&
    !!tool &&
    typeof tool === "object" &&
    typeof (tool as { execute?: unknown }).execute !== "function"
  );
}

export const hasUnresolvedToolCalls = (messages: ModelMessage[]): boolean => {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
      for (const c of (msg as any).content) {
        if (c?.type === "tool-call") toolCallIds.add(c.toolCallId);
      }
    } else if (msg.role === "tool" && Array.isArray((msg as any).content)) {
      for (const c of (msg as any).content) {
        if (c?.type === "tool-result") toolResultIds.add(c.toolCallId);
      }
    }
  }
  for (const id of toolCallIds) if (!toolResultIds.has(id)) return true;
  return false;
};

type ExecuteToolCallOptionsBase = {
  /**
   * When provided, `tool.execute(input, { ..., abortSignal })` receives the
   * signal so each tool implementation can self-cancel its in-flight work.
   * Abort propagates as a thrown `AbortError`; it is NOT stored as a
   * tool-result error (that would poison conversation history with a fake
   * model-visible failure).
   */
  abortSignal?: AbortSignal;
  /**
   * Optional predicate that limits which tool calls get executed in this
   * pass. Unresolved tool calls whose `toolName` returns `false` are
   * skipped (left unresolved) — they will neither execute nor get an
   * error tool-result. Used by progressive discovery to run meta-tool
   * calls before pausing the turn for approval on real MCP tools.
   */
  filterToolName?: (toolName: string) => boolean;
  /**
   * SEP-1865 App-Provided Tools: when true, tool calls whose name isn't in
   * the tool index OR whose tool entry has no `execute` function are SKIPPED
   * (no result written, no throw). Used by the MCPJam free-model handler so
   * that mixed steps containing both server tools and app-aliased tools
   * execute the server tools server-side and leave the app tool calls
   * unresolved — the caller then pauses and lets the client fulfill them
   * in-iframe via `useChat.onToolCall`.
   *
   * Without this flag, app aliases would either trigger "Tool not found" or
   * `tool.execute is not a function`, corrupting the conversation history.
   */
  skipNonExecutableTools?: boolean;
  /**
   * Execute independent tool calls within a step concurrently. Defaults to
   * true, so every hostconfig-driven engine sharing this executor gets
   * parallel execution by default; a step emitting N calls costs one
   * slowest-call latency instead of the sum. Pass `false` to restore strict
   * sequential order for tools whose side effects depend on earlier calls
   * in the same step.
   */
  parallelToolExecution?: boolean;
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: McpModelVisibleToolResultPolicy["modelVisibleMcpToolResults"];
  /**
   * Optional bridge for resolving MCP image `resource_link` results through
   * the originating server's `resources/read` method. Callers must not fetch
   * linked resource URIs directly.
   */
  readLinkedResource?: (params: {
    serverId: string;
    uri: string;
    options?: { abortSignal?: AbortSignal };
  }) => Promise<unknown>;
};

/**
 * MCP `URLElicitationRequiredError` (-32042).
 *
 * Detected STRUCTURALLY, never via `instanceof`: the error may cross package
 * copies (the inspector and the SDK can resolve different upstream client
 * instances), which makes prototype identity unreliable. The shape is the
 * contract.
 */
export const URL_ELICITATION_REQUIRED_CODE = -32042;

export function readUrlElicitations(
  error: unknown,
): Array<{ url: string; elicitationId: string; message?: string }> | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; data?: unknown };
  if (candidate.code !== URL_ELICITATION_REQUIRED_CODE) return null;

  const data = candidate.data as { elicitations?: unknown } | undefined;
  if (!data || !Array.isArray(data.elicitations)) return null;

  const parsed = data.elicitations.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.url !== "string" || typeof item.elicitationId !== "string") {
      return [];
    }
    return [
      {
        url: item.url,
        elicitationId: item.elicitationId,
        ...(typeof item.message === "string" ? { message: item.message } : {}),
      },
    ];
  });

  return parsed.length > 0 ? parsed : null;
}

type ExecuteToolCallOptions = ExecuteToolCallOptionsBase &
  (
    | { tools: ToolsMap }
    | { toolsets: Toolsets }
    | { clientManager: MCPClientManager; serverIds?: string[] }
  );

export async function executeToolCallsFromMessages(
  messages: ModelMessage[],
  options: ExecuteToolCallOptions
): Promise<ModelMessage[]> {
  const signal = options.abortSignal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
  // Build tools with serverId metadata
  let tools: ToolsMap = {};

  if ("clientManager" in options) {
    const flattened = await options.clientManager.getToolsForAiSdk(
      options.serverIds,
      {
        modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
      }
    );
    tools = flattened as ToolsMap;
  } else if ("toolsets" in options) {
    const toolsets = options.toolsets as Toolsets;
    tools = flattenToolsetsWithServerId(toolsets);
  } else {
    tools = options.tools as ToolsMap;
  }

  const index = buildIndexWithAliases(tools);

  const extractServerId = (toolName: string): string | undefined => {
    const tool = index[toolName];
    return tool?._serverId;
  };

  const buildLinkedResourceReader = (
    serverId: string | undefined
  ): McpLinkedResourceReader | undefined => {
    if (!serverId) return undefined;
    if ("clientManager" in options) {
      return ({ uri, options: readOptions }) => {
        const requestOptions = readOptions?.abortSignal
          ? { signal: readOptions.abortSignal }
          : undefined;
        return options.clientManager.readResource(
          serverId,
          { uri },
          requestOptions
        );
      };
    }
    if (options.readLinkedResource) {
      return ({ uri, options: readOptions }) =>
        options.readLinkedResource!({
          serverId,
          uri,
          options: readOptions,
        });
    }
    return undefined;
  };

  // Collect existing tool-result IDs
  const existingToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || msg.role !== "tool" || !Array.isArray((msg as any).content))
      continue;
    for (const c of (msg as any).content) {
      if (c?.type === "tool-result") existingToolResultIds.add(c.toolCallId);
    }
  }

  const resultsByAssistantIdx = new Map<number, ModelMessage[]>();
  const allNewResults: ModelMessage[] = [];

  // Collect every unresolved tool call first, then execute. Calls within a
  // step are independent by contract (the model emitted them in one step),
  // so they run concurrently by default — a step emitting N calls costs one
  // slowest-call latency instead of the sum (HP-6). Results are assembled in
  // call order below, so history ordering is identical either way.
  const pendingToolCalls: Array<{ assistantIdx: number; content: any }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      !msg ||
      msg.role !== "assistant" ||
      !Array.isArray((msg as any).content)
    )
      continue;
    for (const content of (msg as any).content) {
      if (
        content?.type === "tool-call" &&
        !existingToolResultIds.has(content.toolCallId) &&
        (!options.filterToolName ||
          options.filterToolName(content.toolName as string))
      ) {
        pendingToolCalls.push({ assistantIdx: i, content });
      }
    }
  }

  // Executes one tool call to completion. Returns the tool-result message to
  // insert, or null when the call must stay unresolved (skipNonExecutableTools
  // client-fulfilled contract). Aborts throw; every other error is captured
  // as an error-text tool-result.
  const executeSingleToolCall = async (
    content: any
  ): Promise<ModelMessage | null> => {
    throwIfAborted(signal);
    try {
      const toolName: string = content.toolName;
      const tool = index[toolName];
      const directTool = tools[toolName];
      const serverId = extractServerId(toolName);
      const readResource = buildLinkedResourceReader(serverId);
      if (!tool) {
        if (
          isSkippableClientFulfilledToolCall(
            toolName,
            directTool,
            options.skipNonExecutableTools
          )
        ) {
          return null;
        }
        throw new Error(`Tool '${toolName}' not found`);
      }
      if (typeof tool.execute !== "function") {
        if (
          isSkippableClientFulfilledToolCall(
            toolName,
            tool,
            options.skipNonExecutableTools
          )
        ) {
          return null;
        }
        throw new Error(`Tool '${toolName}' has no execute function`);
      }
      const toolCall = content as {
        input?: unknown;
        args?: unknown;
      };
      const input = toolCall.input ?? toolCall.args ?? {};
      const result = await tool.execute(input, {
        toolCallId: content.toolCallId,
        messages,
        ...(signal ? { abortSignal: signal } : {}),
      });

      // If a tool ignored the signal (or returned `result` after the
      // signal fired) the result must NOT be serialized into a
      // tool-result — that would persist into conversation history
      // and look like a completed tool call to the next turn.
      throwIfAborted(signal);

      // AI SDK tool contract: when a tool defines `toModelOutput`, the
      // model-visible output is its mapping of the implementation result
      // — e.g. the eval `computer` tool turns `{screenshotBase64}` into
      // `{type:"content", value:[{type:"media",…}]}` so the AI SDK
      // can convert it to provider-level image data and make it model-visible.
      // Generic toModelOutput tools (like the eval `computer` tool) do not
      // duplicate raw implementation output, because content outputs can
      // already carry large model-facing payloads. SDK-converted MCP tools
      // opt in to preserving the raw result for UI/debug hydration.
      const toModelOutput = (
        tool as {
          toModelOutput?: (ctx: {
            output: unknown;
            abortSignal?: AbortSignal;
          }) => ToolResultPart | Promise<ToolResultPart>;
        }
      ).toModelOutput;
      if (typeof toModelOutput === "function") {
        const mappedOutput = await toModelOutput({
          output: result,
          ...(signal ? { abortSignal: signal } : {}),
        });
        throwIfAborted(signal);
        const providerOptions = mergeMcpToolOriginMetadata(
          undefined,
          serverId
        );
        // MCP App tools scrub structuredContent from the model-facing copy
        // (`mappedOutput`), but their widgets read structuredContent from
        // the raw result. Preserve the raw result for UI hydration whenever
        // it carries structuredContent — the model copy no longer does.
        // Other toModelOutput tools (e.g. the eval `computer` tool) return
        // no structuredContent, so they keep omitting `result:` and don't
        // bloat subsequent per-step request bodies with large content.
        const rawHasStructuredContent =
          !!result &&
          typeof result === "object" &&
          "structuredContent" in (result as Record<string, unknown>);
        const preserveRawResultForUi = shouldPreserveRawResultForUi(tool);
        return {
          role: "tool" as const,
          content: [
            {
              type: "tool-result",
              toolCallId: content.toolCallId,
              toolName: toolName,
              output: mappedOutput,
              // UI-only raw result for app-tool widgets (stripped from the
              // model copy via `output`/toModelOutput above).
              ...(rawHasStructuredContent || preserveRawResultForUi
                ? { result }
                : {}),
              serverId,
              ...(providerOptions ? { providerOptions } : {}),
            },
          ],
        } as any;
      }

      let output: ToolResultPart;
      if (result !== undefined && result !== null) {
        if (typeof result === "object") {
          const mcpOutput = await maybeMcpModelOutput(result, {
            modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
            readResource,
            abortSignal: signal,
          });
          throwIfAborted(signal);
          if (mcpOutput) {
            output = mcpOutput;
          } else {
            const serialized = serializeToolResult(result);
            if (serialized.success) {
              output = { type: "json", value: serialized.value } as any;
            } else {
              output = {
                type: "text",
                value: serialized.fallbackText,
              } as any;
            }
          }
        } else {
          output = { type: "text", value: String(result) } as any;
        }
      } else {
        output = { type: "json", value: null } as any;
      }

      // For MCP app tools, scrub _meta and structuredContent from the
      // output that goes to the LLM, while preserving the full result
      // for the UI.
      let llmOutput = output;
      if (
        "clientManager" in options &&
        serverId &&
        result &&
        typeof result === "object"
      ) {
        const toolsMetadata =
          options.clientManager.getAllToolsMetadata(serverId);
        const toolMeta = toolsMetadata[toolName];
        if (isMcpAppTool(toolMeta)) {
          const scrubbed = scrubMetaAndStructuredContentFromToolResult(
            result as any
          );
          const scrubbedMcpOutput = await maybeMcpModelOutput(scrubbed, {
            modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
            readResource,
            abortSignal: signal,
          });
          throwIfAborted(signal);
          if (scrubbedMcpOutput) {
            llmOutput = scrubbedMcpOutput;
          } else {
            const scrubbedSerialized = serializeToolResult(scrubbed);
            if (scrubbedSerialized.success) {
              llmOutput = {
                type: "json",
                value: scrubbedSerialized.value,
              } as any;
            }
          }
        }
      }

      throwIfAborted(signal);

      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: content.toolCallId,
            toolName: toolName,
            output: llmOutput,
            // Preserve full result including _meta for UI hydration
            result: result,
            // Add serverId for OpenAI component resolution
            serverId,
            ...(serverId
              ? {
                  providerOptions: mergeMcpToolOriginMetadata(
                    undefined,
                    serverId
                  ),
                }
              : {}),
          },
        ],
      } as any;
    } catch (error: any) {
      // Abort errors must propagate — they represent user/client
      // cancellation, NOT a tool failure. Capturing them as an
      // error-text result would persist a phantom "tool failed" into
      // conversation history.
      if (isAbortError(error)) {
        throw error;
      }
      // Hosted MRTR (§12.5): a tool call that returned `input_required` was
      // SUSPENDED to a durable continuation by the collector, which threw the
      // suspend signal to unwind and return control to the worker. Like an
      // abort, this must propagate — capturing it as an error-text result would
      // both hide the pause AND poison history with a phantom tool failure.
      if (isMrtrSuspendSignalShape(error)) {
        throw error;
      }
      // -32042: the server wants an out-of-band interaction first. Surface
      // the URLs structurally to the UI and give the model an actionable
      // retry hint instead of a raw protocol error it can't interpret.
      // Surfacing the URL to the UI is the tool wrapper's job (see
      // `web-chat-turn`), which sits on the shared tool set and therefore
      // fires for every engine. Here we only reshape the model-visible
      // result so it gets an actionable retry hint instead of a raw
      // protocol error.
      const urlElicitations = readUrlElicitations(error);
      const errorOutput: ToolResultPart = {
        type: "error-text",
        value: urlElicitations
          ? "This tool needs the user to complete an interaction at a URL first. The user has been shown the link and may complete it out of band. Retry this tool once they confirm they're done."
          : error instanceof Error
            ? error.message
            : String(error),
      } as any;
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: content.toolCallId,
            toolName: content.toolName,
            output: errorOutput,
          },
        ],
      } as any;
    }
  };

  // An abort rejection from any call propagates (nothing below runs, no
  // results are inserted) — matching sequential abort semantics, where the
  // throw prevented the final splice.
  //
  // A hosted-MRTR SUSPEND signal is different: it means one tool call paused to
  // a durable continuation while SIBLING calls in the same step already ran to
  // completion. Their side effects happened, so their results MUST be spliced
  // before the suspend propagates — otherwise the resume (which only re-drives
  // the suspended call) would leave the siblings unresolved and the next turn
  // would re-execute them, double-firing their side effects (exactly-once
  // violation). We therefore collect completed results, splice them, and only
  // THEN rethrow the suspend.
  let outcomes: Array<ModelMessage | null> = [];
  let suspendSignal: unknown;
  if (options.parallelToolExecution === false) {
    for (const pending of pendingToolCalls) {
      try {
        outcomes.push(await executeSingleToolCall(pending.content));
      } catch (error) {
        if (isMrtrSuspendSignalShape(error)) {
          suspendSignal = error;
          break;
        }
        throw error;
      }
    }
  } else {
    const settled = await Promise.allSettled(
      pendingToolCalls.map((pending) => executeSingleToolCall(pending.content))
    );
    // Preserve Promise.all abort semantics: a NON-suspend rejection (abort or
    // an unexpected throw) fails the whole batch with nothing spliced.
    for (const s of settled) {
      if (s.status === "rejected" && !isMrtrSuspendSignalShape(s.reason)) {
        throw s.reason;
      }
    }
    for (const s of settled) {
      if (s.status === "fulfilled") {
        outcomes.push(s.value);
      } else {
        suspendSignal = suspendSignal ?? s.reason;
        outcomes.push(null);
      }
    }
  }

  // Assemble in original call order so history is deterministic regardless
  // of completion order.
  for (let k = 0; k < pendingToolCalls.length; k++) {
    const outcome = outcomes[k];
    if (!outcome) continue;
    const { assistantIdx } = pendingToolCalls[k];
    if (!resultsByAssistantIdx.has(assistantIdx))
      resultsByAssistantIdx.set(assistantIdx, []);
    resultsByAssistantIdx.get(assistantIdx)!.push(outcome);
    allNewResults.push(outcome);
  }

  // Insert right after corresponding assistant messages (reverse order to preserve indices)
  const sortedKeys = [...resultsByAssistantIdx.keys()].sort((a, b) => b - a);
  for (const idx of sortedKeys) {
    messages.splice(idx + 1, 0, ...resultsByAssistantIdx.get(idx)!);
  }

  // Completed sibling results are now spliced into `messages`; surface the
  // durable-pause signal so the engine can suspend the turn.
  if (suspendSignal) {
    throw suspendSignal;
  }

  return allNewResults;
}

function serializeToolResult(
  result: Record<string, unknown> | Array<unknown> | object
):
  | { success: true; value: unknown }
  | { success: false; fallbackText: string } {
  const seen = new WeakSet<object>();

  try {
    const sanitized = JSON.parse(
      JSON.stringify(result, (_key, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }

        if (typeof value === "function") {
          return undefined;
        }

        if (value && typeof value === "object") {
          if (seen.has(value as object)) {
            return undefined;
          }
          seen.add(value as object);
        }

        return value;
      })
    );

    return { success: true, value: sanitized ?? null };
  } catch (error) {
    let fallbackText: string;
    try {
      fallbackText = JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      fallbackText = String(result);
    }

    if (error instanceof Error) {
      fallbackText = `Failed to serialize tool result: ${error.message}. Raw result: ${fallbackText}`;
    }

    return {
      success: false,
      fallbackText,
    };
  }
}
