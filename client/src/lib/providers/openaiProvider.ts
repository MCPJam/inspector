import OpenAI from "openai";
import {
  AIProvider,
  ProviderConfig,
  ProviderCreateOptions,
  ProviderResponse,
  ProviderMessage,
  ProviderTool,
  ProviderResponseContent,
} from "./types";

export class OpenAIProvider extends AIProvider {
  private openai: OpenAI;

  constructor(config: ProviderConfig) {
    super(config);
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: config.dangerouslyAllowBrowser ?? true,
    });
  }

  updateApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    this.openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: this.config.dangerouslyAllowBrowser ?? true,
    });
  }

  validateConfig(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.length > 0);
  }

  getProviderName(): string {
    return "openai";
  }

  getDefaultModel(): string {
    return "gpt-4o";
  }

  getSupportedModels(): string[] {
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
      "o1-preview",
      "o1-mini",
    ];
  }

  async createMessage(options: ProviderCreateOptions): Promise<ProviderResponse> {
    const openaiMessages = this.convertToOpenAIMessages(options.messages);
    const openaiTools = options.tools ? this.convertToOpenAITools(options.tools) : undefined;

    const response = await this.openai.chat.completions.create({
      model: options.model,
      max_tokens: options.max_tokens,
      messages: openaiMessages,
      tools: openaiTools,
    });

    return this.convertFromOpenAIResponse(response);
  }

  private convertToOpenAIMessages(messages: ProviderMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    
    for (const message of messages) {
      if (typeof message.content === "string") {
        result.push({
          role: message.role === "user" ? "user" : "assistant",
          content: message.content,
        });
        continue;
      }

      // Handle complex content with tool calls/results
      if (message.role === "assistant") {
        const textContent = message.content.find(item => item.type === "text");
        const toolCalls = message.content.filter(item => item.type === "tool_use");

        const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: textContent?.text || null,
        };

        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls.map(toolCall => ({
            id: toolCall.id || "",
            type: "function" as const,
            function: {
              name: toolCall.name || "",
              arguments: JSON.stringify(toolCall.input || {}),
            },
          }));
        }

        result.push(assistantMessage);
      } else {
        // Handle user messages with tool results
        const toolResults = message.content.filter(item => item.type === "tool_result");
        
        if (toolResults.length > 0) {
          // OpenAI expects tool results as separate tool messages
          for (const result_item of toolResults) {
            result.push({
              role: "tool",
              tool_call_id: result_item.tool_use_id || "",
              content: result_item.content || "",
            });
          }
        } else {
          // Regular user message
          const textContent = message.content.find(item => item.type === "text");
          result.push({
            role: "user",
            content: textContent?.text || "",
          });
        }
      }
    }
    
    return result;
  }

  private convertToOpenAITools(tools: ProviderTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool): OpenAI.Chat.Completions.ChatCompletionTool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertFromOpenAIResponse(response: OpenAI.Chat.Completions.ChatCompletion): ProviderResponse {
    const choice = response.choices[0];
    const message = choice.message;
    
    const content: ProviderResponseContent[] = [];

    // Add text content if present
    if (message.content) {
      content.push({
        type: "text",
        text: message.content,
      });
    }

    // Add tool calls if present
    if (message.tool_calls) {
      message.tool_calls.forEach(toolCall => {
        if (toolCall.type === "function") {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || "{}"),
          });
        }
      });
    }

    return {
      content,
      model: response.model,
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      } : undefined,
    };
  }
} 