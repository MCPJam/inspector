import { FormEvent, useMemo, useState, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useAuth } from "@workos-inc/authkit-react";
// removed: button/textarea used in Thread component
import { ModelDefinition } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
// removed: model selector used in Thread component
import { JsonRpcLoggerView } from "./logging/json-rpc-logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
// removed: elicitation dialog used in Thread component
import { Thread } from "@/components/chat-v2/thread";
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
    <div className="flex flex-1 h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 h-full"
      >
        <ResizablePanel defaultSize={70} minSize={40} className="min-w-0">
          <Thread
            messages={messages}
            input={input}
            status={status}
            isLoading={isLoading}
            effectiveModel={effectiveModel}
            availableModels={availableModels}
            onModelChange={(m) => setSelectedModelId(String(m.id))}
            setInput={setInput}
            onSubmit={onSubmit}
            elicitation={elicitation}
            elicitationLoading={elicitationLoading}
            onElicitationResponse={handleElicitationResponse}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={30}
          minSize={20}
          maxSize={50}
          className="min-w-[260px] min-h-0 overflow-hidden"
        >
          <div className="h-full minh-0 overflow-hidden">
            <JsonRpcLoggerView />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
