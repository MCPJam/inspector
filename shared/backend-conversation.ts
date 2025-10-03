import type { ModelMessage, Tool } from "ai";
import { hasUnresolvedToolCalls } from "./http-tool-calls";

export type BackendFetchPayload = {
  tools: Tool[];
  messages: string;
};

export type BackendFetchResponse = {
  ok?: boolean;
  messages?: ModelMessage[];
  [key: string]: unknown;
};

export type BackendToolCallEvent = {
  name: string;
  params: unknown;
};

export type BackendToolResultEvent = {
  toolName?: string;
  result: unknown;
  error?: unknown;
};

export type BackendConversationHandlers = {
  onAssistantText?: (text: string) => void;
  onToolCall?: (call: BackendToolCallEvent) => void;
  onToolResult?: (result: BackendToolResultEvent) => void;
  onStepComplete?: (payload: {
    step: number;
    text: string;
    toolCalls: BackendToolCallEvent[];
    toolResults: BackendToolResultEvent[];
  }) => void;
};

export type BackendConversationOptions = {
  maxSteps: number;
  messageHistory: ModelMessage[];
  toolDefinitions: Tool[];
  executeToolCalls: (messages: ModelMessage[]) => Promise<void>;
  fetchBackend: (
    payload: BackendFetchPayload,
  ) => Promise<BackendFetchResponse | null>;
  handlers?: BackendConversationHandlers;
};

export type BackendConversationResult = {
  steps: number;
  messageHistory: ModelMessage[];
};

const extractToolResultValue = (raw: unknown) => {
  if (
    raw &&
    typeof raw === "object" &&
    "value" in (raw as Record<string, unknown>)
  ) {
    return (raw as Record<string, unknown>).value;
  }

  return raw;
};

export const runBackendConversation = async (
  options: BackendConversationOptions,
): Promise<BackendConversationResult> => {
  const { handlers } = options;
  let step = 0;

  while (step < options.maxSteps) {
    const payload: BackendFetchPayload = {
      tools: options.toolDefinitions,
      messages: JSON.stringify(options.messageHistory),
    };
    const data = await options.fetchBackend(payload);

    if (!data || !data.ok || !Array.isArray(data.messages)) {
      break;
    }

    const iterationToolCalls: BackendToolCallEvent[] = [];
    const iterationToolResults: BackendToolResultEvent[] = [];
    let iterationText = "";

    for (const msg of data.messages) {
      options.messageHistory.push(msg);

      const content = (msg as any).content;
      if ((msg as any).role === "assistant" && Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === "text" && typeof item.text === "string") {
            iterationText += item.text;
            handlers?.onAssistantText?.(item.text);
          } else if (item?.type === "tool-call") {
            const name = item.toolName ?? item.name;
            if (!name) {
              continue;
            }
            const params = item.input ?? item.parameters ?? item.args ?? {};
            const callEvent: BackendToolCallEvent = { name, params };
            iterationToolCalls.push(callEvent);
            handlers?.onToolCall?.(callEvent);
          }
        }
      }
    }

    const unresolved = hasUnresolvedToolCalls(options.messageHistory as any);

    if (unresolved) {
      const beforeLen = options.messageHistory.length;
      await options.executeToolCalls(options.messageHistory);
      const newMessages = options.messageHistory.slice(beforeLen);

      for (const msg of newMessages) {
        const content = (msg as any).content;
        if ((msg as any).role === "tool" && Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "tool-result") {
              const rawOutput =
                item.output ??
                item.result ??
                item.value ??
                item.data ??
                item.content;
              const resultEvent: BackendToolResultEvent = {
                toolName: item.toolName ?? item.name,
                result: extractToolResultValue(rawOutput),
                error: item.error,
              };
              iterationToolResults.push(resultEvent);
              handlers?.onToolResult?.(resultEvent);
            }
          }
        }
      }
    }

    step += 1;

    handlers?.onStepComplete?.({
      step,
      text: iterationText,
      toolCalls: iterationToolCalls,
      toolResults: iterationToolResults,
    });

    if (!unresolved) {
      break;
    }
  }

  return {
    steps: step,
    messageHistory: options.messageHistory,
  };
};
