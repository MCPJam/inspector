import { FormEvent, useMemo, useState, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelDefinition } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { ModelSelector } from "@/components/chat/model-selector";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import {
  buildAvailableModels,
  getDefaultModel,
} from "@/components/chat-v2/model-helpers";
import { isMCPJamProvidedModel } from "@/shared/types";

export function ChatTabV2() {
  const { getAccessToken } = useAuth();
  const {
    hasToken,
    getToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
  } = useAiProviderKeys();

  const [input, setInput] = useState("");
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [authHeaders, setAuthHeaders] = useState<
    Record<string, string> | undefined
  >(undefined);

  const availableModels = useMemo(() => {
    return buildAvailableModels({
      hasToken,
      getLiteLLMBaseUrl,
      getLiteLLMModelAlias,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
    });
  }, [
    hasToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
  ]);

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const effectiveModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(availableModels);
    if (!selectedModelId) return fallback;
    const found = availableModels.find((m) => String(m.id) === selectedModelId);
    return found ?? fallback;
  }, [availableModels, selectedModelId]);

  const [elicitation, setElicitation] = useState<DialogElicitation | null>(
    null,
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);

  const transport = useMemo(() => {
    const apiKey = getToken(effectiveModel.provider as keyof ProviderTokens);
    return new DefaultChatTransport({
      api: "/api/mcp/chat-v2",
      body: {
        model: effectiveModel,
        apiKey: apiKey,
        temperature: 0.7,
      },
      headers: authHeaders,
    });
  }, [effectiveModel, getToken, authHeaders]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await getAccessToken?.();
        if (!active) return;
        if (token) {
          setAuthHeaders({ Authorization: `Bearer ${token}` });
        } else {
          setAuthHeaders(undefined);
        }
      } catch {
        if (!active) return;
        setAuthHeaders(undefined);
      }
    })();
    return () => {
      active = false;
    };
  }, [getAccessToken]);

  const isMcpJamModel = useMemo(() => {
    return effectiveModel?.id
      ? isMCPJamProvidedModel(String(effectiveModel.id))
      : false;
  }, [effectiveModel]);

  const { messages, sendMessage, status } = useChat({
    id: `chat-${effectiveModel.provider}-${effectiveModel.id}`,
    transport: transport!,
    // Disable client auto-send for MCPJam-provided models; server handles tool loop
    sendAutomaticallyWhen: isMcpJamModel
      ? undefined
      : lastAssistantMessageIsCompleteWithToolCalls,
  });

  const isLoading = status === "streaming";

  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels } =
        await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);

      const toolCapable = isRunning
        ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
        : [];
      const toolCapableSet = new Set(toolCapable);
      const ollamaDefs: ModelDefinition[] = availableModels.map(
        (modelName) => ({
          id: modelName,
          name: modelName,
          provider: "ollama" as const,
          disabled: !toolCapableSet.has(modelName),
          disabledReason: toolCapableSet.has(modelName)
            ? undefined
            : "Model does not support tool calling",
        }),
      );
      setOllamaModels(ollamaDefs);
    };
    checkOllama();
    const interval = setInterval(checkOllama, 30000);
    return () => clearInterval(interval);
  }, [getOllamaBaseUrl]);

  // selectedModelId defaults via effectiveModel; no effect needed

  useEffect(() => {
    const es = new EventSource("/api/mcp/elicitation/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === "elicitation_request") {
          setElicitation({
            requestId: data.requestId,
            message: data.message,
            schema: data.schema,
            timestamp: data.timestamp || new Date().toISOString(),
          });
        } else if (data?.type === "elicitation_complete") {
          setElicitation((prev) =>
            prev?.requestId === data.requestId ? null : prev,
          );
        }
      } catch (error) {
        console.warn("[ChatTabV2] Failed to parse elicitation event:", error);
      }
    };
    es.onerror = () => {
      console.warn(
        "[ChatTabV2] Elicitation SSE connection error, browser will retry",
      );
    };
    return () => es.close();
  }, []);

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => {
    if (!elicitation) return;
    setElicitationLoading(true);
    try {
      await fetch("/api/mcp/elicitation/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: elicitation.requestId,
          action,
          content: parameters,
        }),
      });
      setElicitation(null);
    } finally {
      setElicitationLoading(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (input.trim() && status === "ready") {
      sendMessage({ text: input });
      setInput("");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-background px-6 py-3 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Model:</span>
        <ModelSelector
          currentModel={effectiveModel}
          availableModels={availableModels}
          onModelChange={(m) => setSelectedModelId(String(m.id))}
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
                if (part.type === "text") {
                  return <span key={index}>{part.text}</span>;
                }

                // Step boundaries between tool calls
                if (part.type === "step-start") {
                  return (
                    <div key={index} className="my-2 opacity-60">
                      <hr className="border-border" />
                    </div>
                  );
                }

                // Dynamic tools (unknown types at compile-time)
                if (part.type === "dynamic-tool") {
                  const anyPart = part as any;
                  const state = anyPart.state as string | undefined;
                  return (
                    <div key={index} className="mt-2 text-xs">
                      <div className="font-medium">
                        🔧 Tool: {anyPart.toolName}
                      </div>
                      {state === "input-streaming" ||
                      state === "input-available" ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
                          {JSON.stringify(anyPart.input, null, 2)}
                        </pre>
                      ) : null}
                      {state === "output-available" ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words">
                          {JSON.stringify(anyPart.output, null, 2)}
                        </pre>
                      ) : null}
                      {state === "output-error" ? (
                        <div className="mt-1 text-destructive">
                          Error: {anyPart.errorText}
                        </div>
                      ) : null}
                    </div>
                  );
                }

                // Statically-typed tools (tool-<name>)
                if (
                  typeof part.type === "string" &&
                  part.type.startsWith("tool-")
                ) {
                  const anyPart = part as any;
                  const toolName = (part.type as string).slice(5);
                  const state = anyPart.state as string | undefined;
                  return (
                    <div key={index} className="mt-2 text-xs">
                      <div className="font-medium">🔧 Tool: {toolName}</div>
                      {state === "input-streaming" ||
                      state === "input-available" ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
                          {JSON.stringify(anyPart.input, null, 2)}
                        </pre>
                      ) : null}
                      {state === "output-available" ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words">
                          {JSON.stringify(anyPart.output, null, 2)}
                        </pre>
                      ) : null}
                      {state === "output-error" ? (
                        <div className="mt-1 text-destructive">
                          Error: {anyPart.errorText}
                        </div>
                      ) : null}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          </div>
        ))}
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
          disabled={status !== "ready"}
          className="mb-2"
        />
        <div className="flex justify-end gap-2">
          {isLoading && (
            <Button type="button" variant="outline" onClick={() => {}}>
              Stop
            </Button>
          )}
          <Button type="submit" disabled={!input.trim() || status !== "ready"}>
            Send
          </Button>
        </div>
      </form>
      <ElicitationDialog
        elicitationRequest={elicitation}
        onResponse={handleElicitationResponse}
        loading={elicitationLoading}
      />
    </div>
  );
}
