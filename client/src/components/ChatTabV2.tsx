import { FormEvent, useMemo, useState } from "react";
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelDefinition, SUPPORTED_MODELS } from "@/shared/types";
import { ProviderTokens, useAiProviderKeys } from "@/hooks/use-ai-provider-keys";

export function ChatTabV2() {
  const { hasToken, getToken } = useAiProviderKeys();
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelDefinition | null>(null);

  const availableModels = useMemo(() => {
    return SUPPORTED_MODELS.filter((model) => {
      if (hasToken(model.provider as keyof ProviderTokens)) {
        return true;
      }
      return false;
    });
  }, [hasToken]);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: '/api/mcp/chat-v2',
      body: {
        modelId: selectedModel?.id,
        apiKey: getToken(selectedModel?.provider as keyof ProviderTokens),
        temperature: 0.7,
      },
    });
  }, [selectedModel]);

  const { messages, sendMessage, status } = useChat({
    transport,
  });

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
                if (part.type === 'text') {
                  return <span key={index}>{part.text}</span>;
                } else if (part.type.startsWith('tool-')) {
                  return (
                    <div key={index} className="text-xs opacity-70 mt-1">
                      🔧 Tool call
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
