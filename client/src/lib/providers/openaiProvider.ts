import OpenAI from "openai";
import {
  AIProvider,
  ProviderConfig,
  ProviderCreateOptions,
  ProviderResponse,
  ProviderMessage,
  ProviderTool,
  ProviderResponseContent,
  ProviderModel,
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

  getSupportedModels(): ProviderModel[] {
    return [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "Most advanced GPT-4 model with enhanced capabilities"
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        description: "Faster and more affordable GPT-4o model"
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        description: "Advanced GPT-4 model with improved speed"
      },
      {
        id: "gpt-4",
        name: "GPT-4",
        description: "Powerful GPT-4 model for complex tasks"
      },
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        description: "Fast and efficient model for most tasks"
      }
    ];
  }
  

  async createMessage(options: ProviderCreateOptions): Promise<ProviderResponse> {
    const openaiMessages = this.convertToOpenAIMessages(options.messages);
    const openaiTools = options.tools ? this.convertToOpenAITools(options.tools) : undefined;

    try {
      const response = await this.openai.chat.completions.create({
        model: options.model,
        max_tokens: options.max_tokens,
        messages: openaiMessages,
        tools: openaiTools,
      });

      return this.convertFromOpenAIResponse(response);
    } catch (error: unknown) {
      // Handle OpenAI-specific errors with better messaging
      const openaiError = error as { status?: number; message?: string };
      if (openaiError?.status === 429) {
        throw new Error(
          `OpenAI Rate Limit Exceeded: ${openaiError?.message || 'Too many requests. Please check your OpenAI plan and billing, or try again later.'}`
        );
      } else if (openaiError?.status === 401) {
        throw new Error(
          `OpenAI Authentication Error: Invalid API key. Please check your OpenAI API key in settings.`
        );
      } else if (openaiError?.status === 403) {
        throw new Error(
          `OpenAI Permission Error: ${openaiError?.message || 'Access denied. Please check your OpenAI account permissions.'}`
        );
      } else if (openaiError?.status === 400) {
        throw new Error(
          `OpenAI Request Error: ${openaiError?.message || 'Invalid request. Please check your model selection and parameters.'}`
        );
      } else if (openaiError?.status && openaiError.status >= 500) {
        throw new Error(
          `OpenAI Server Error: ${openaiError?.message || 'OpenAI service is currently unavailable. Please try again later.'}`
        );
      }
      
      // Re-throw the original error if it's not a recognized OpenAI error
      throw error;
    }
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