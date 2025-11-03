import {
  FormEvent,
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  generateId,
} from "ai";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ModelDefinition } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { JsonRpcLoggerView } from "./logging/json-rpc-logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
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
import { ChatInput } from "@/components/chat-v2/chat-input";
import { Thread } from "@/components/chat-v2/thread";
import { ServerWithName } from "@/hooks/use-app-state";
import { getToolsMetadata, ToolServerMap } from "@/lib/mcp-tools-api";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { ConnectMcpServerCallout } from "@/components/chat-v2/connect-mcp-server-callout";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to MCP tools.";

interface ChatTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
}

export function ChatTabV2({
  connectedServerConfigs,
  selectedServerNames,
}: ChatTabProps) {
  const { getAccessToken, signUp } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
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
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [temperature, setTemperature] = useState(0.7);
  const [chatSessionId, setChatSessionId] = useState(generateId());
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, any>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});
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
  const selectedModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(availableModels);
    if (!selectedModelId) return fallback;
    const found = availableModels.find((m) => String(m.id) === selectedModelId);
    return found ?? fallback;
  }, [availableModels, selectedModelId]);

  const [elicitation, setElicitation] = useState<DialogElicitation | null>(
    null,
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);

  const selectedConnectedServerNames = useMemo(
    () =>
      selectedServerNames.filter(
        (name) =>
          connectedServerConfigs[name]?.connectionStatus === "connected",
      ),
    [selectedServerNames, connectedServerConfigs],
  );
  const noServersConnected = selectedConnectedServerNames.length === 0;

  const transport = useMemo(() => {
    const apiKey = getToken(selectedModel.provider as keyof ProviderTokens);
    return new DefaultChatTransport({
      api: "/api/mcp/chat-v2",
      body: {
        model: selectedModel,
        apiKey: apiKey,
        temperature,
        systemPrompt,
        selectedServers: selectedConnectedServerNames,
      },
      headers: authHeaders,
    });
  }, [
    selectedModel,
    getToken,
    authHeaders,
    temperature,
    systemPrompt,
    selectedConnectedServerNames,
  ]);

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
    return selectedModel?.id
      ? isMCPJamProvidedModel(String(selectedModel.id))
      : false;
  }, [selectedModel]);

  const { messages, sendMessage, stop, status, setMessages } = useChat({
    id: chatSessionId,
    transport: transport!,
    // Disable client auto-send for MCPJam-provided models; server handles tool loop
    sendAutomaticallyWhen: isMcpJamModel
      ? undefined
      : lastAssistantMessageIsCompleteWithToolCalls,
  });
  const resetChat = useCallback(() => {
    setChatSessionId(generateId());
    setMessages([]);
    setInput("");
  }, [setMessages]);

  useEffect(() => {
    resetChat();
  }, [resetChat]);

  const previousSelectedServersRef = useRef<string[]>(
    selectedConnectedServerNames,
  );

  useEffect(() => {
    const previousNames = previousSelectedServersRef.current;
    const currentNames = selectedConnectedServerNames;
    const hasChanged =
      previousNames.length !== currentNames.length ||
      previousNames.some((name, index) => name !== currentNames[index]);

    if (hasChanged) {
      resetChat();
    }

    previousSelectedServersRef.current = currentNames;
  }, [selectedConnectedServerNames, resetChat]);

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

  useEffect(() => {
    const fetchToolsMetadata = async () => {
      const { metadata, toolServerMap } = await getToolsMetadata(
        selectedConnectedServerNames,
      );
      setToolsMetadata(metadata);
      setToolServerMap(toolServerMap);
    };
    fetchToolsMetadata();
  }, [selectedConnectedServerNames]);

  const disableForAuthentication = !isAuthenticated && isMcpJamModel;
  const disableForServers = noServersConnected;
  const isStreaming = status === "streaming" || status === "submitted";
  const inputDisabled =
    disableForAuthentication || disableForServers || status !== "ready";

  let placeholder = "Ask something…";
  if (disableForServers) {
    placeholder = "Connect an MCP server to send your first message";
  }
  if (disableForAuthentication) {
    placeholder = "Sign in to use free chat";
  }

  const shouldShowUpsell = disableForAuthentication;
  const shouldShowConnectCallout = disableForServers && !shouldShowUpsell;
  const showDisabledCallout =
    messages.length === 0 && (shouldShowUpsell || shouldShowConnectCallout);
  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      input.trim() &&
      status === "ready" &&
      !disableForAuthentication &&
      !disableForServers
    ) {
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
          <div className="flex flex-col bg-background h-full min-h-0 overflow-hidden">
            {showDisabledCallout ? (
              <div className="flex-1 flex items-center justify-center px-4">
                <div className="max-w-4xl w-full">
                  {shouldShowUpsell ? (
                    <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                  ) : (
                    <ConnectMcpServerCallout />
                  )}
                </div>
              </div>
            ) : (
              <Thread
                messages={messages}
                sendFollowUpMessage={(text: string) => sendMessage({ text })}
                model={selectedModel}
                isLoading={status === "submitted"}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
              />
            )}
            <div className="bg-background/80 backdrop-blur-sm flex-shrink-0">
              <div className="max-w-4xl mx-auto p-4">
                <ChatInput
                  value={input}
                  onChange={setInput}
                  onSubmit={onSubmit}
                  stop={stop}
                  disabled={inputDisabled}
                  isLoading={isStreaming}
                  placeholder={placeholder}
                  currentModel={selectedModel}
                  availableModels={availableModels}
                  onModelChange={(model) => {
                    setSelectedModelId(String(model.id));
                    resetChat();
                  }}
                  systemPrompt={systemPrompt}
                  onSystemPromptChange={setSystemPrompt}
                  temperature={temperature}
                  onTemperatureChange={setTemperature}
                  hasMessages={messages.length > 0}
                  onResetChat={resetChat}
                />
              </div>
            </div>

            <ElicitationDialog
              elicitationRequest={elicitation}
              onResponse={handleElicitationResponse}
              loading={elicitationLoading}
            />
          </div>
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
