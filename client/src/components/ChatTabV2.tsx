import { FormEvent, useMemo, useState, useEffect } from "react";
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelDefinition, SUPPORTED_MODELS } from "@/shared/types";
import { ProviderTokens, useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { ModelSelector } from "@/components/chat/model-selector";

export function ChatTabV2() {
  const { hasToken, getToken } = useAiProviderKeys();
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelDefinition>(SUPPORTED_MODELS[0]);

  const availableModels = useMemo(() => {
    return SUPPORTED_MODELS.filter((model) => {
      if (hasToken(model.provider as keyof ProviderTokens)) {
        return true;
      }
      return false;
    });
  }, [hasToken]);

  useEffect(() => {
    if (availableModels.length > 0) {
      setSelectedModel(availableModels[0]);
    }
  }, [availableModels]);

  const transport = useMemo(() => {
    const apiKey = getToken(selectedModel.provider as keyof ProviderTokens);
    console.log("[ChatTabV2] apiKey", apiKey);
    return new DefaultChatTransport({
      api: '/api/mcp/chat-v2',
      body: {
        modelId: selectedModel.id,
        apiKey: apiKey,
        temperature: 0.7,
      },
    });
  }, [selectedModel, getToken]);

  const { messages, sendMessage, status, addToolResult } = useChat({
    id: `chat-${selectedModel.id}`, // Force re-initialization when model changes
    transport,
    // Automatically submit when all tool results are available
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // We don't auto-run any client tools here; MCP tools execute server-side.
    // Keeping handler for future client tools (no-op for dynamic tools).
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      // Example placeholder for client tools if ever added:
      // if (toolCall.toolName === 'someClientTool') {
      //   addToolResult({ tool: 'someClientTool', toolCallId: toolCall.toolCallId, output: { ok: true } });
      // }
    },
  });

  // Keep addToolResult available for future client-side tools
  void addToolResult;

  console.log("[ChatTabV2] messages", messages);

  const isLoading = status === 'streaming';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (input.trim() && status === 'ready') {
      sendMessage({ text: input });
      setInput('');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-background px-6 py-3 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Model:</span>
        <ModelSelector
          currentModel={selectedModel}
          availableModels={availableModels}
          onModelChange={setSelectedModel}
          isLoading={isLoading}
        />
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex w-full ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-xl rounded-lg px-3 py-2 text-sm ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              {message.parts.map((part, index) => {
                // Text content
                if (part.type === 'text') {
                  return <span key={index}>{part.text}</span>;
                }

                // Step boundaries between tool calls
                if (part.type === 'step-start') {
                  return (
                    <div key={index} className="my-2 opacity-60">
                      <hr className="border-border" />
                    </div>
                  );
                }

                // Dynamic tools (unknown types at compile-time)
                if (part.type === 'dynamic-tool') {
                  const anyPart = part as any;
                  const state = anyPart.state as string | undefined;
                  return (
                    <div key={index} className="mt-2 text-xs">
                      <div className="font-medium">🔧 Tool: {anyPart.toolName}</div>
                      {state === 'input-streaming' || state === 'input-available' ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
{JSON.stringify(anyPart.input, null, 2)}
                        </pre>
                      ) : null}
                      {state === 'output-available' ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words">
{JSON.stringify(anyPart.output, null, 2)}
                        </pre>
                      ) : null}
                      {state === 'output-error' ? (
                        <div className="mt-1 text-destructive">Error: {anyPart.errorText}</div>
                      ) : null}
                    </div>
                  );
                }

                // Statically-typed tools (tool-<name>)
                if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
                  const anyPart = part as any;
                  const toolName = (part.type as string).slice(5);
                  const state = anyPart.state as string | undefined;
                  return (
                    <div key={index} className="mt-2 text-xs">
                      <div className="font-medium">🔧 Tool: {toolName}</div>
                      {state === 'input-streaming' || state === 'input-available' ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
{JSON.stringify(anyPart.input, null, 2)}
                        </pre>
                      ) : null}
                      {state === 'output-available' ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words">
{JSON.stringify(anyPart.output, null, 2)}
                        </pre>
                      ) : null}
                      {state === 'output-error' ? (
                        <div className="mt-1 text-destructive">Error: {anyPart.errorText}</div>
                      ) : null}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="text-sm text-muted-foreground">Assistant is thinking…</div>
        )}
      </div>
      <form
        onSubmit={onSubmit}
        className="border-t border-border bg-background px-6 py-4"
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something…"
          rows={4}
          disabled={status !== 'ready'}
          className="mb-2"
        />
        <div className="flex justify-end gap-2">
          {isLoading && (
            <Button type="button" variant="outline" onClick={() => {}}>
              Stop
            </Button>
          )}
          <Button type="submit" disabled={!input.trim() || status !== 'ready'}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
